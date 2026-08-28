import { db, schema } from "../db/connection.js";
import { eq, desc, inArray } from "drizzle-orm";
import { getPortfolioHoldings } from "./calculations.js";

export type TargetWeight = { stockId: string; weight: number; sleeve?: string };
export type ProposedTrade = {
  stockId: string;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  reason: string;
};

async function latestPrice(stockId: string): Promise<number> {
  const rows = await db.select().from(schema.stockPrices)
    .where(eq(schema.stockPrices.stockId, stockId))
    .orderBy(desc(schema.stockPrices.date))
    .limit(1);
  return rows[0] ? Number(rows[0].price) : 0;
}

export async function buildPortfolioSnapshot(portfolioId: string) {
  const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  const portfolio = portfolios[0];
  if (!portfolio) throw new Error("Portfolio not found");
  const holdings = await getPortfolioHoldings(portfolioId);
  const cash = Number(portfolio.cashBalance ?? 0);
  const invested = holdings.reduce((s, h) => s + h.currentValue, 0);
  const nav = invested + cash;
  const stockIds = holdings.map((h) => h.stockId);
  const stocks = stockIds.length
    ? await db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
    : [];
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sectors: Record<string, number> = {};
  const holdingRows = holdings.map((h) => {
    const s = stockMap.get(h.stockId);
    const weight = nav > 0 ? h.currentValue / nav : 0;
    if (s) sectors[s.sector] = (sectors[s.sector] ?? 0) + weight;
    return {
      stockId: h.stockId,
      ticker: s?.ticker ?? "",
      sector: s?.sector ?? "",
      quantity: h.quantity,
      marketValue: h.currentValue,
      weight,
      avgCost: h.avgCost,
      unrealizedPnL: h.currentValue - h.totalCost,
    };
  });

  return {
    asOf: new Date().toISOString(),
    nav,
    cash,
    invested,
    holdings: holdingRows,
    sectors: Object.entries(sectors).map(([sector, weight]) => ({ sector, weight })),
    metrics: {
      topWeight: holdingRows.reduce((m, h) => Math.max(m, h.weight), 0),
      positionCount: holdingRows.length,
    },
  };
}

export async function proposeTrades(portfolioId: string, targets: TargetWeight[]): Promise<ProposedTrade[]> {
  const snapshot = await buildPortfolioSnapshot(portfolioId);
  const holdings = await getPortfolioHoldings(portfolioId);
  const holdingMap = new Map(holdings.map((h) => [h.stockId, h]));
  const nav = snapshot.nav || 1;
  const stockIds = [...new Set([...targets.map((t) => t.stockId), ...holdings.map((h) => h.stockId)])];
  const stocks = stockIds.length
    ? await db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
    : [];
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const targetMap = new Map(targets.map((t) => [t.stockId, t.weight]));
  const trades: ProposedTrade[] = [];

  for (const stockId of stockIds) {
    const targetW = targetMap.get(stockId) ?? 0;
    const current = holdingMap.get(stockId);
    const currentMv = current?.currentValue ?? 0;
    const targetMv = targetW * nav;
    const delta = targetMv - currentMv;
    if (Math.abs(delta) < 1) continue;
    const price = await latestPrice(stockId);
    if (price <= 0) continue;
    const qty = Math.floor(Math.abs(delta) / price);
    if (qty <= 0) continue;
    const stock = stockMap.get(stockId);
    trades.push({
      stockId,
      ticker: stock?.ticker ?? "",
      side: delta > 0 ? "BUY" : "SELL",
      quantity: qty,
      estimatedPrice: price,
      estimatedValue: qty * price,
      reason: delta > 0 ? "Increase to target weight" : "Reduce to target weight",
    });
  }

  return trades;
}

export function nextRebalanceCode(seq: number): string {
  const y = new Date().getFullYear();
  return `RB-${y}-${String(seq).padStart(5, "0")}`;
}
