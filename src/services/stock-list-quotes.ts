import { db, schema } from "../db/connection.js";
import { sql } from "drizzle-orm";

const tn = (v: unknown) => Number(v ?? 0);

export type StockQuoteExtras = {
  currentPrice: number;
  dayChangePct: number;
  sparkline: number[];
};

/**
 * Batch-load latest price, prior close change, and up to 30 sparkline points
 * for many stocks in one SQL pass (avoids N+1 on GET /stocks).
 */
export async function loadStockListQuotes(
  stockIds: string[],
): Promise<Map<string, StockQuoteExtras>> {
  const out = new Map<string, StockQuoteExtras>();
  for (const id of stockIds) {
    out.set(id, { currentPrice: 0, dayChangePct: 0, sparkline: [] });
  }
  if (stockIds.length === 0) return out;

  const result = await db.execute(sql`
    SELECT stock_id, date::text AS date, price, rn
    FROM (
      SELECT
        stock_id,
        date,
        price,
        ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS rn
      FROM stock_prices
    ) ranked
    WHERE rn <= 30
  `);

  const rawRows: Record<string, unknown>[] = Array.isArray(result)
    ? (result as unknown as Record<string, unknown>[])
    : ((result as { rows: Record<string, unknown>[] }).rows ?? []);
  const byStock = new Map<string, Array<{ rn: number; price: number }>>();

  for (const row of rawRows) {
    const id = String(row.stock_id ?? row.stockId ?? "");
    if (!id || !out.has(id)) continue;
    const rn = Number(row.rn);
    const price = tn(row.price);
    const list = byStock.get(id) ?? [];
    list.push({ rn, price });
    byStock.set(id, list);
  }

  for (const [id, points] of byStock) {
    points.sort((a, b) => a.rn - b.rn);
    const latest = points[0];
    const prev = points[1];
    const cp = latest?.price ?? 0;
    const pp = prev?.price ?? cp;
    const chg = pp > 0 ? Math.round(((cp - pp) / pp) * 1_000_000) / 10_000 : 0;
    const sparkline = [...points].sort((a, b) => b.rn - a.rn).map((p) => p.price);
    out.set(id, { currentPrice: cp, dayChangePct: chg, sparkline });
  }

  return out;
}

/** Top absolute day movers among stocks that have at least one price. */
export async function listStockMovers(limit = 5): Promise<
  Array<typeof schema.stocks.$inferSelect & StockQuoteExtras>
> {
  const all = await db.select().from(schema.stocks).orderBy(schema.stocks.ticker);
  const quotes = await loadStockListQuotes(all.map((s) => s.id));
  return all
    .map((s) => ({ ...s, ...(quotes.get(s.id) ?? { currentPrice: 0, dayChangePct: 0, sparkline: [] }) }))
    .filter((s) => s.sparkline.length > 0 || s.currentPrice > 0)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct))
    .slice(0, Math.max(1, Math.min(limit, 50)));
}
