import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";

function closeOf(p: { price: string; closePrice: string | null }) {
  return Number(p.closePrice ?? p.price);
}

export async function getMarketOverview() {
  const indices = await db.select().from(schema.indices);
  const indexSnapshots = [];

  for (const idx of indices) {
    const points = await db.select().from(schema.indexDataPoints)
      .where(eq(schema.indexDataPoints.indexId, idx.id))
      .orderBy(desc(schema.indexDataPoints.date))
      .limit(2);
    const latest = points[0];
    const prev = points[1];
    const level = latest ? Number(latest.value) : null;
    const prevLevel = prev ? Number(prev.value) : null;
    const change = level != null && prevLevel != null ? level - prevLevel : null;
    const changePct = change != null && prevLevel ? (change / prevLevel) * 100 : null;
    indexSnapshots.push({
      id: idx.id,
      name: idx.name,
      date: latest?.date ?? null,
      level,
      change,
      changePct,
    });
  }

  const latestDateRow = await db.select({ d: sql<string>`max(${schema.stockPrices.date})` })
    .from(schema.stockPrices);
  const asOf = latestDateRow[0]?.d ?? null;

  let breadth = { advancers: 0, decliners: 0, unchanged: 0, asOf };
  const movers: Array<{
    stockId: string; ticker: string; companyName: string; sector: string;
    close: number; prevClose: number; changePct: number; volume: number | null; value: number | null;
  }> = [];

  if (asOf) {
    const prices = await db.select({
      stockId: schema.stockPrices.stockId,
      price: schema.stockPrices.price,
      closePrice: schema.stockPrices.closePrice,
      volume: schema.stockPrices.volume,
      ticker: schema.stocks.ticker,
      companyName: schema.stocks.companyName,
      sector: schema.stocks.sector,
    })
      .from(schema.stockPrices)
      .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockPrices.stockId))
      .where(and(
        eq(schema.stockPrices.date, asOf),
        eq(schema.stocks.instrumentType, "equity"),
      ));

    // Prior close per stock: latest price strictly before asOf
    const prevMap = new Map<string, number>();
    for (const p of prices) {
      const prevRows = await db.select({
        price: schema.stockPrices.price,
        closePrice: schema.stockPrices.closePrice,
      }).from(schema.stockPrices)
        .where(and(
          eq(schema.stockPrices.stockId, p.stockId),
          lt(schema.stockPrices.date, asOf),
        ))
        .orderBy(desc(schema.stockPrices.date))
        .limit(1);
      if (prevRows[0]) prevMap.set(p.stockId, closeOf(prevRows[0]));
    }

    for (const p of prices) {
      const prevClose = prevMap.get(p.stockId);
      if (prevClose == null || !prevClose) continue;
      const close = closeOf(p);
      const changePct = ((close - prevClose) / prevClose) * 100;
      if (changePct > 0.0001) breadth.advancers += 1;
      else if (changePct < -0.0001) breadth.decliners += 1;
      else breadth.unchanged += 1;

      const vol = p.volume != null ? Number(p.volume) : null;
      movers.push({
        stockId: p.stockId,
        ticker: p.ticker,
        companyName: p.companyName,
        sector: p.sector,
        close,
        prevClose,
        changePct,
        volume: vol,
        value: vol != null ? vol * close : null,
      });
    }
  }

  const byPct = [...movers].sort((a, b) => b.changePct - a.changePct);
  const byValue = [...movers].filter((m) => m.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return {
    asOf,
    indices: indexSnapshots,
    breadth,
    topGainers: byPct.slice(0, 10),
    topLosers: byPct.slice(-10).reverse(),
    topByValue: byValue.slice(0, 10),
  };
}

export type ScreenerFilters = {
  sector?: string;
  shariahGroup?: string;
  illiquid?: boolean;
  regulatoryStatus?: string;
  qeriMember?: boolean;
  dsmMember?: boolean;
  minAdtv?: number;
  search?: string;
};

export async function runScreener(filters: ScreenerFilters = {}) {
  const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.instrumentType, "equity"));
  const approved = await db.select().from(schema.stockApprovedList);
  const approvedMap = new Map(approved.map((a) => [a.stockId, a.status]));
  const scores = await db.select().from(schema.stockScores);
  const scoreMap = new Map(scores.map((s) => [s.stockId, s]));

  const latestDateRow = await db.select({ d: sql<string>`max(${schema.stockPrices.date})` })
    .from(schema.stockPrices);
  const asOf = latestDateRow[0]?.d ?? null;
  const priceMap = new Map<string, number>();
  if (asOf) {
    const prices = await db.select().from(schema.stockPrices).where(eq(schema.stockPrices.date, asOf));
    for (const p of prices) priceMap.set(p.stockId, closeOf(p));
  }

  let rows = stocks.map((s) => ({
    id: s.id,
    ticker: s.ticker,
    companyName: s.companyName,
    sector: s.sector,
    shariahGroup: s.shariahGroup,
    isQeriMember: s.isQeriMember,
    isDsmMember: s.isDsmMember,
    avgDailyTradedValue: s.avgDailyTradedValue != null ? Number(s.avgDailyTradedValue) : null,
    isIlliquid: s.isIlliquid,
    regulatoryStatus: s.regulatoryStatus,
    lastClose: priceMap.get(s.id) ?? null,
    approvedListStatus: approvedMap.get(s.id) ?? "watchlist",
    advisoryScore: scoreMap.get(s.id)?.score != null ? Number(scoreMap.get(s.id)!.score) : null,
    valuation: null as null,
    valuationNote: "UNKNOWN — fundamentals pack not sourced; do not invent P/E P/B yield",
  }));

  if (filters.sector) rows = rows.filter((r) => r.sector === filters.sector);
  if (filters.shariahGroup) rows = rows.filter((r) => r.shariahGroup === filters.shariahGroup);
  if (filters.illiquid === true) rows = rows.filter((r) => r.isIlliquid);
  if (filters.illiquid === false) rows = rows.filter((r) => !r.isIlliquid);
  if (filters.regulatoryStatus) rows = rows.filter((r) => r.regulatoryStatus === filters.regulatoryStatus);
  if (filters.qeriMember === true) rows = rows.filter((r) => r.isQeriMember);
  if (filters.dsmMember === true) rows = rows.filter((r) => r.isDsmMember);
  if (filters.minAdtv != null) {
    rows = rows.filter((r) => (r.avgDailyTradedValue ?? 0) >= filters.minAdtv!);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    rows = rows.filter((r) => r.ticker.toLowerCase().includes(q) || r.companyName.toLowerCase().includes(q));
  }

  return { asOf, count: rows.length, data: rows };
}

export async function getStockAnalytics(stockId: string, days = 120) {
  const stockRows = await db.select().from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
  if (!stockRows[0]) throw Object.assign(new Error("Stock not found"), { status: 404 });

  const prices = await db.select().from(schema.stockPrices)
    .where(eq(schema.stockPrices.stockId, stockId))
    .orderBy(desc(schema.stockPrices.date))
    .limit(Math.max(days + 50, 60));

  const chronological = [...prices].reverse();
  const series = chronological.map((p, i, arr) => {
    const window = arr.slice(Math.max(0, i - 49), i + 1);
    const ma50 = window.length === 50
      ? window.reduce((s, x) => s + closeOf(x), 0) / 50
      : null;
    return {
      date: p.date,
      open: p.openPrice != null ? Number(p.openPrice) : null,
      high: p.highPrice != null ? Number(p.highPrice) : null,
      low: p.lowPrice != null ? Number(p.lowPrice) : null,
      close: closeOf(p),
      volume: p.volume != null ? Number(p.volume) : null,
      ma50,
    };
  });

  return {
    stock: {
      id: stockRows[0].id,
      ticker: stockRows[0].ticker,
      companyName: stockRows[0].companyName,
      sector: stockRows[0].sector,
    },
    series: series.slice(-days),
    note: "Research aid only — charts do not change compliance outcomes.",
  };
}
