import { describe, expect, it } from "vitest";
import { buildEquityValueHistory } from "./equity-value-history.js";

type Tx = { timestamp: string; stockId: string; type: string; quantity: number };

function bruteForce(
  txs: Tx[],
  stockMap: Map<string, { date: string; price: number }[]>,
  asOf?: string,
): { date: string; value: number }[] {
  if (txs.length === 0) return [];
  const firstTxDate = new Date(txs[0].timestamp).toISOString().slice(0, 10);
  const allDates = new Set<string>();
  for (const prices of stockMap.values()) {
    for (const p of prices) {
      if (p.date >= firstTxDate && (!asOf || p.date <= asOf)) allDates.add(p.date);
    }
  }
  const sortedDates = [...allDates].sort();
  const result: { date: string; value: number }[] = [];
  for (const targetDate of sortedDates) {
    const qMap = new Map<string, number>();
    for (const tx of txs) {
      if (new Date(tx.timestamp).toISOString().slice(0, 10) > targetDate) continue;
      const curr = qMap.get(tx.stockId) || 0;
      if (tx.type !== "SELL") qMap.set(tx.stockId, curr + tx.quantity);
      else qMap.set(tx.stockId, Math.max(0, curr - tx.quantity));
    }
    let total = 0;
    for (const [stockId, qty] of qMap) {
      if (qty <= 0.0001) continue;
      const prices = stockMap.get(stockId);
      if (!prices) continue;
      let price = 0;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].date <= targetDate) { price = prices[i].price; break; }
      }
      total += qty * price;
    }
    result.push({ date: targetDate, value: Math.round(total * 10000) / 10000 });
  }
  return result;
}

describe("buildEquityValueHistory — incremental qty replay (FIN-01)", () => {
  const stockMap = new Map<string, { date: string; price: number }[]>([
    ["A", [
      { date: "2024-01-01", price: 10 },
      { date: "2024-01-02", price: 11 },
      { date: "2024-01-03", price: 12 },
    ]],
    ["B", [
      { date: "2024-01-01", price: 5 },
      { date: "2024-01-03", price: 6 },
    ]],
  ]);
  const txs: Tx[] = [
    { timestamp: "2024-01-01T10:00:00.000Z", stockId: "A", type: "BUY", quantity: 100 },
    { timestamp: "2024-01-02T10:00:00.000Z", stockId: "B", type: "BUY", quantity: 50 },
    { timestamp: "2024-01-03T10:00:00.000Z", stockId: "A", type: "SELL", quantity: 40 },
  ];

  it("matches the previous per-date full replay", () => {
    expect(buildEquityValueHistory(txs, stockMap)).toEqual(bruteForce(txs, stockMap));
  });

  it("values lots with last close on or before the date", () => {
    expect(buildEquityValueHistory(txs, stockMap)).toEqual([
      { date: "2024-01-01", value: 1000 },
      { date: "2024-01-02", value: 1350 },
      { date: "2024-01-03", value: 1020 },
    ]);
  });

  it("clips to asOf without changing earlier points", () => {
    expect(buildEquityValueHistory(txs, stockMap, "2024-01-02")).toEqual(bruteForce(txs, stockMap, "2024-01-02"));
    expect(buildEquityValueHistory(txs, stockMap, "2024-01-02")).toEqual([
      { date: "2024-01-01", value: 1000 },
      { date: "2024-01-02", value: 1350 },
    ]);
  });

  it("returns [] when there are no trades", () => {
    expect(buildEquityValueHistory([], stockMap)).toEqual([]);
  });
});
