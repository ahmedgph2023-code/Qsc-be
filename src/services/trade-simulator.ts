import { db, schema } from "../db/connection.js";
import { eq } from "drizzle-orm";
import { getPortfolioHoldings } from "./calculations.js";
import { runCompliance } from "./compliance-engine.js";
import { isStockEligible } from "./mandate-rules.js";
import { findClosingPriceOnDate } from "./trade-cash.js";

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

export type SimLeg = {
  stockId: string;
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  commissionRate?: number;
};

/**
 * Pre-trade what-if: cash / weight / sector / compliance impact.
 * Does not write orders or transactions.
 */
export async function simulateTrade(portfolioId: string, legs: SimLeg[]) {
  if (!legs.length) {
    throw Object.assign(new Error("At least one leg required"), { status: 400 });
  }

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });

  const [mandate] = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1);
  if (!mandate || mandate.approvalStatus !== "approved") {
    throw Object.assign(new Error("Mandate must be approved before simulation"), { status: 403, code: "MANDATE_NOT_APPROVED" });
  }

  const holdings = await getPortfolioHoldings(portfolioId);
  const cashBefore = Number(portfolio.cashBalance ?? 0);
  const qtyByStock = new Map(holdings.map((h) => [h.stockId, h.quantity]));
  const costByStock = new Map(holdings.map((h) => [h.stockId, h.totalCost]));
  const priceByStock = new Map(holdings.map((h) => [h.stockId, h.currentPrice]));
  const sectorByStock = new Map(holdings.map((h) => [h.stockId, h.sector]));
  const tickerByStock = new Map(holdings.map((h) => [h.stockId, h.ticker]));
  const today = new Date().toISOString().slice(0, 10);

  let cashAfter = cashBefore;
  const legResults: Array<{
    stockId: string;
    ticker: string;
    side: string;
    quantity: number;
    price: number;
    tradeValue: number;
    commission: number;
    cashDelta: number;
  }> = [];

  for (const leg of legs) {
    const qty = Number(leg.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error("Quantity must be positive"), { status: 400 });
    }
    const elig = await isStockEligible({
      shariahPreference: mandate.shariahPreference,
      stockId: leg.stockId,
      mandateId: mandate.id,
    });
    if (leg.side === "BUY" && !elig.allowed) {
      throw Object.assign(new Error(`Stock not eligible: ${elig.reasons.join(", ")}`), { status: 400, code: "NOT_ELIGIBLE" });
    }

    const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, leg.stockId)).limit(1);
    if (!stock) throw Object.assign(new Error("Stock not found"), { status: 404 });

    let price = leg.price != null && Number(leg.price) > 0 ? Number(leg.price) : priceByStock.get(leg.stockId);
    if (price == null || !(price > 0)) {
      const mkt = await findClosingPriceOnDate(leg.stockId, today);
      price = mkt?.close ?? 0;
    }
    if (!(price > 0)) throw Object.assign(new Error(`No price for ${stock.ticker}`), { status: 400 });

    const tradeValue = round4(qty * price);
    const commission = round4(tradeValue * (leg.commissionRate ?? 0));
    const cashDelta = leg.side === "BUY" ? -(tradeValue + commission) : tradeValue - commission;
    cashAfter = round4(cashAfter + cashDelta);

    const held = qtyByStock.get(leg.stockId) ?? 0;
    if (leg.side === "SELL" && held + 0.0001 < qty) {
      throw Object.assign(new Error(`Insufficient shares for ${stock.ticker}`), { status: 400, code: "INSUFFICIENT_SHARES" });
    }
    const nextQty = leg.side === "BUY" ? held + qty : held - qty;
    qtyByStock.set(leg.stockId, nextQty);
    const prevCost = costByStock.get(leg.stockId) ?? 0;
    if (leg.side === "BUY") {
      costByStock.set(leg.stockId, prevCost + tradeValue);
    } else if (held > 0) {
      costByStock.set(leg.stockId, Math.max(0, prevCost * (nextQty / held)));
    }
    priceByStock.set(leg.stockId, price);
    sectorByStock.set(leg.stockId, stock.sector);
    tickerByStock.set(leg.stockId, stock.ticker);

    legResults.push({
      stockId: leg.stockId,
      ticker: stock.ticker,
      side: leg.side,
      quantity: qty,
      price,
      tradeValue,
      commission,
      cashDelta,
    });
  }

  if (cashAfter < -0.0001) {
    throw Object.assign(new Error("Simulation would leave negative cash"), { status: 400, code: "INSUFFICIENT_CASH" });
  }

  const equityAfter = [...qtyByStock.entries()].reduce((s, [id, q]) => {
    if (q <= 0.0001) return s;
    return s + q * (priceByStock.get(id) ?? 0);
  }, 0);
  const navAfter = round4(equityAfter + cashAfter);

  const stockWeights = [...qtyByStock.entries()]
    .filter(([, q]) => q > 0.0001)
    .map(([stockId, q]) => {
      const mv = q * (priceByStock.get(stockId) ?? 0);
      return {
        stockId,
        ticker: tickerByStock.get(stockId) ?? stockId,
        sector: sectorByStock.get(stockId) ?? "—",
        quantity: round4(q),
        marketValue: round4(mv),
        weight: navAfter > 0 ? round4(mv / navAfter) : 0,
      };
    });

  const sectorMap = new Map<string, number>();
  for (const row of stockWeights) {
    sectorMap.set(row.sector, (sectorMap.get(row.sector) ?? 0) + row.weight);
  }
  const sectorWeights = [...sectorMap.entries()].map(([sector, weight]) => ({ sector, weight: round4(weight) }));

  const compliance = await runCompliance({
    portfolioId,
    timing: "before_trade",
    targetWeights: stockWeights.map((s) => ({ stockId: s.stockId, weight: s.weight })),
    persist: false,
  });

  const beforeNav = holdings.reduce((s, h) => s + h.currentValue, 0) + cashBefore;
  const weightImpact = stockWeights.map((s) => {
    const h = holdings.find((x) => x.stockId === s.stockId);
    const before = beforeNav > 0 && h ? h.currentValue / beforeNav : 0;
    return { stockId: s.stockId, ticker: s.ticker, before: round4(before), after: s.weight, delta: round4(s.weight - before) };
  });

  return {
    portfolioId,
    cashBefore: round4(cashBefore),
    cashAfter,
    equityAfter: round4(equityAfter),
    navAfter,
    legs: legResults,
    stockWeights,
    sectorWeights,
    weightImpact,
    compliance,
  };
}
