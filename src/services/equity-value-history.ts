import { isSell } from "../lib/tx-type.js";

function toNum(v: unknown): number { return Number(v ?? 0); }

function txDate(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}

export type EquityPricePoint = { date: string; price: number };

/** Mark-to-market equity path. Same numbers as the old O(dates × txs) walk; incremental qty + price pointer. */
export function buildEquityValueHistory(
  txs: Array<{ timestamp: Date | string; stockId: string; type: string; quantity: unknown }>,
  stockMap: Map<string, EquityPricePoint[]>,
  asOf?: string,
): { date: string; value: number }[] {
  if (txs.length === 0) return [];

  const firstTxDate = txDate(txs[0].timestamp);
  const allDates = new Set<string>();
  for (const prices of stockMap.values()) {
    for (const p of prices) {
      if (p.date >= firstTxDate && (!asOf || p.date <= asOf)) allDates.add(p.date);
    }
  }

  const sortedDates = [...allDates].sort();
  const qMap = new Map<string, number>();
  const priceIdx = new Map<string, number>();
  let txIdx = 0;
  const result: { date: string; value: number }[] = [];

  for (const targetDate of sortedDates) {
    while (txIdx < txs.length && txDate(txs[txIdx].timestamp) <= targetDate) {
      const tx = txs[txIdx];
      const qty = toNum(tx.quantity);
      const curr = qMap.get(tx.stockId) || 0;
      if (!isSell(tx.type)) qMap.set(tx.stockId, curr + qty);
      else qMap.set(tx.stockId, Math.max(0, curr - qty));
      txIdx++;
    }
    let total = 0;
    for (const [stockId, qty] of qMap) {
      if (qty <= 0.0001) continue;
      const prices = stockMap.get(stockId);
      if (!prices?.length) continue;
      let i = priceIdx.get(stockId) ?? -1;
      while (i + 1 < prices.length && prices[i + 1].date <= targetDate) i++;
      priceIdx.set(stockId, i);
      const price = i >= 0 && prices[i].date <= targetDate ? prices[i].price : 0;
      total += qty * price;
    }
    result.push({ date: targetDate, value: Math.round(total * 10000) / 10000 });
  }
  return result;
}
