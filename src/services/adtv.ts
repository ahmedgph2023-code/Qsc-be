import { db, schema } from "../db/connection.js";
import { eq, desc, and, isNotNull } from "drizzle-orm";

const DEFAULT_LOOKBACK_DAYS = 20;
const DEFAULT_ILLIQUID_THRESHOLD = 100_000;

/**
 * ADTV (Avg Daily Traded Value) is computed from market price history,
 * NOT from client portfolio transactions:
 *   ADTV = average(close × volume) over the last N trading days that have volume.
 */
export async function computeAdtvFromMarketData(
  stockId: string,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<number | null> {
  const rows = await db
    .select({
      price: schema.stockPrices.price,
      closePrice: schema.stockPrices.closePrice,
      volume: schema.stockPrices.volume,
    })
    .from(schema.stockPrices)
    .where(and(eq(schema.stockPrices.stockId, stockId), isNotNull(schema.stockPrices.volume)))
    .orderBy(desc(schema.stockPrices.date))
    .limit(lookbackDays);

  const tradedValues: number[] = [];
  for (const row of rows) {
    const vol = Number(row.volume ?? 0);
    const px = Number(row.closePrice ?? row.price ?? 0);
    if (vol > 0 && px > 0) tradedValues.push(px * vol);
  }
  if (tradedValues.length === 0) return null;
  return tradedValues.reduce((a, b) => a + b, 0) / tradedValues.length;
}

export async function refreshStockAdtv(stockId: string, illiquidThreshold = DEFAULT_ILLIQUID_THRESHOLD) {
  const adtv = await computeAdtvFromMarketData(stockId);
  await db
    .update(schema.stocks)
    .set({
      avgDailyTradedValue: adtv != null ? String(Math.round(adtv * 10000) / 10000) : null,
      isIlliquid: adtv != null ? adtv < illiquidThreshold : false,
      updatedAt: new Date(),
    })
    .where(eq(schema.stocks.id, stockId));
  return adtv;
}

export async function refreshStocksAdtv(stockIds: string[]) {
  for (const id of stockIds) {
    await refreshStockAdtv(id);
  }
}
