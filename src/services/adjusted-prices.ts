import { db, schema } from "../db/connection.js";
import { eq, asc, gt } from "drizzle-orm";

const tn = (v: unknown): number => Number(v ?? 0);

export async function rebuildAdjustedPrices(stockId: string): Promise<void> {
  console.log(`[adjusted-prices] Rebuilding adjusted prices for stock ${stockId}...`);

  const rawPrices = await db
    .select()
    .from(schema.stockPrices)
    .where(eq(schema.stockPrices.stockId, stockId))
    .orderBy(asc(schema.stockPrices.date));

  console.log(`[adjusted-prices] Fetched ${rawPrices.length} raw prices`);

  if (rawPrices.length === 0) {
    console.log(`[adjusted-prices] No raw prices — skipping`);
    return;
  }

  const actions = await db
    .select()
    .from(schema.corporateActions)
    .where(eq(schema.corporateActions.stockId, stockId))
    .orderBy(asc(schema.corporateActions.actionDate));

  const nonDividendActions = actions.filter(
    (a) => a.actionType === "BONUS" || a.actionType === "STOCK_SPLIT"
  );
  console.log(`[adjusted-prices] ${actions.length} corporate actions (${nonDividendActions.length} non-dividend)`);

  const start = Date.now();
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.adjustedPrices)
      .where(eq(schema.adjustedPrices.stockId, stockId));

    let logged = 0;
    for (const rp of rawPrices) {
      let factor = 1;
      for (const ca of nonDividendActions) {
        if (ca.actionDate > rp.date) {
          factor *= tn(ca.ratio);
        }
      }

      const rawClose = tn(rp.price);
      const adjClose = factor > 0 ? rawClose / factor : rawClose;

      await tx.insert(schema.adjustedPrices).values({
        stockId,
        tradeDate: rp.date,
        rawClose: String(rawClose),
        adjustedClose: String(adjClose),
        adjustmentFactor: String(factor),
      });

      logged++;
      if (logged % 1000 === 0) {
        console.log(`[adjusted-prices] Computed ${logged}/${rawPrices.length} rows...`);
      }
    }
  });

  console.log(`[adjusted-prices] Done — ${rawPrices.length} adjusted price rows in ${Date.now() - start}ms`);
}

export interface TotalReturnPoint {
  date: string;
  adjustedClose: number;
  dividend: number;
  dailyReturn: number | null;
  tri: number;
}

export async function computeTotalReturn(stockId: string): Promise<TotalReturnPoint[]> {
  const adjPrices = await db
    .select()
    .from(schema.adjustedPrices)
    .where(eq(schema.adjustedPrices.stockId, stockId))
    .orderBy(asc(schema.adjustedPrices.tradeDate));

  if (adjPrices.length === 0) return [];

  const dividends = await db
    .select()
    .from(schema.corporateActions)
    .where(eq(schema.corporateActions.stockId, stockId));

  const dividendMap = new Map<string, number>();
  for (const d of dividends) {
    if (d.actionType === "DIVIDEND") {
      dividendMap.set(d.actionDate, tn(d.cashAmount));
    }
  }

  const result: TotalReturnPoint[] = [];
  let tri = 100;

  for (let i = 0; i < adjPrices.length; i++) {
    const row = adjPrices[i];
    const adjClose = tn(row.adjustedClose);
    const div = dividendMap.get(row.tradeDate) || 0;

    let dailyReturn: number | null = null;
    if (i > 0) {
      const prevAdjClose = tn(adjPrices[i - 1].adjustedClose);
      if (prevAdjClose > 0) {
        dailyReturn = (adjClose + div) / prevAdjClose - 1;
      }
    }

    if (dailyReturn !== null) {
      tri = tri * (1 + dailyReturn);
    }

    result.push({
      date: row.tradeDate,
      adjustedClose: Math.round(adjClose * 10000) / 10000,
      dividend: div,
      dailyReturn: dailyReturn !== null ? Math.round(dailyReturn * 1000000) / 10000 : null,
      tri: Math.round(tri * 10000) / 10000,
    });
  }

  return result;
}

export interface PerformanceMetrics {
  rawClose: number;
  adjustedClose: number;
  dailyReturn: number | null;
  monthlyReturn: number | null;
  ytdReturn: number | null;
  annualReturn: number | null;
  sinceInceptionReturn: number | null;
}

export async function computePerformanceMetrics(stockId: string): Promise<PerformanceMetrics | null> {
  const adjPrices = await db
    .select()
    .from(schema.adjustedPrices)
    .where(eq(schema.adjustedPrices.stockId, stockId))
    .orderBy(asc(schema.adjustedPrices.tradeDate));

  if (adjPrices.length === 0) return null;

  const triData = await computeTotalReturn(stockId);
  if (triData.length === 0) return null;

  const last = adjPrices[adjPrices.length - 1];
  const lastTri = triData[triData.length - 1];

  // Daily return
  let dailyReturn: number | null = null;
  if (triData.length >= 2) {
    const prevTri = triData[triData.length - 2];
    if (prevTri.tri > 0) {
      dailyReturn = (lastTri.tri / prevTri.tri - 1) * 100;
    }
    dailyReturn = dailyReturn !== null ? Math.round(dailyReturn * 10000) / 10000 : null;
  }

  // Monthly return: compare TRI ~30 calendar days ago
  let monthlyReturn: number | null = null;
  const lastDate = last.tradeDate;
  const lastDateObj = new Date(lastDate);
  const monthAgo = new Date(lastDateObj);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const monthAgoStr = monthAgo.toISOString().split("T")[0];

  let monthAgoTri: number | null = null;
  for (let i = triData.length - 1; i >= 0; i--) {
    if (triData[i].date <= monthAgoStr) {
      monthAgoTri = triData[i].tri;
      break;
    }
  }
  if (monthAgoTri !== null && monthAgoTri > 0) {
    monthlyReturn = (lastTri.tri / monthAgoTri - 1) * 100;
    monthlyReturn = Math.round(monthlyReturn * 10000) / 10000;
  }

  // YTD return
  let ytdReturn: number | null = null;
  const currentYear = lastDateObj.getFullYear();
  const yearStartStr = `${currentYear}-01-01`;

  let yearStartTri: number | null = null;
  for (let i = triData.length - 1; i >= 0; i--) {
    if (triData[i].date >= yearStartStr) {
      // Find the first available date in this year
    }
  }
  // Find first TRI of current year
  for (let i = 0; i < triData.length; i++) {
    if (triData[i].date >= yearStartStr) {
      yearStartTri = triData[i].tri;
      break;
    }
  }
  if (yearStartTri !== null && yearStartTri > 0) {
    ytdReturn = (lastTri.tri / yearStartTri - 1) * 100;
    ytdReturn = Math.round(ytdReturn * 10000) / 10000;
  }

  // Annual return: last available year
  let annualReturn: number | null = null;
  const lastYear = lastDateObj.getFullYear();
  let lastYearStartTri: number | null = null;
  let lastYearEndTri: number | null = null;

  for (let i = 0; i < triData.length; i++) {
    const d = triData[i].date;
    const y = parseInt(d.split("-")[0]);
    if (y === lastYear && lastYearStartTri === null) {
      lastYearStartTri = triData[i].tri;
    }
    if (y === lastYear) {
      lastYearEndTri = triData[i].tri;
    }
  }
  if (lastYearStartTri !== null && lastYearEndTri !== null && lastYearStartTri > 0) {
    annualReturn = (lastYearEndTri / lastYearStartTri - 1) * 100;
    annualReturn = Math.round(annualReturn * 10000) / 10000;
  }

  // Since inception
  let sinceInceptionReturn: number | null = null;
  if (triData.length > 0) {
    const firstTri = triData[0].tri;
    if (firstTri > 0) {
      sinceInceptionReturn = (lastTri.tri / firstTri - 1) * 100;
      sinceInceptionReturn = Math.round(sinceInceptionReturn * 10000) / 10000;
    }
  }

  return {
    rawClose: Math.round(tn(last.rawClose) * 10000) / 10000,
    adjustedClose: Math.round(tn(last.adjustedClose) * 10000) / 10000,
    dailyReturn,
    monthlyReturn,
    ytdReturn,
    annualReturn,
    sinceInceptionReturn,
  };
}

export async function getFirstPriceDate(stockId: string): Promise<string | null> {
  const prices = await db
    .select()
    .from(schema.stockPrices)
    .where(eq(schema.stockPrices.stockId, stockId))
    .orderBy(asc(schema.stockPrices.date))
    .limit(1);

  return prices.length > 0 ? prices[0].date : null;
}
