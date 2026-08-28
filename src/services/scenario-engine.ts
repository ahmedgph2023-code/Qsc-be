import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { simulateTrade, type SimLeg } from "./trade-simulator.js";
import { getPortfolioHoldings } from "./calculations.js";
import { runCompliance } from "./compliance-engine.js";
import { writeAudit } from "./audit.js";

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

export async function runScenario(params: {
  kind: "multi_trade" | "price_shock" | "liquidity_stress" | "cash_deploy" | "benchmark_relative";
  portfolioId: string;
  name?: string;
  legs?: SimLeg[];
  shockPct?: number;
  stockIds?: string[];
  sector?: string;
  persist?: boolean;
  userId?: string;
}) {
  const holdings = await getPortfolioHoldings(params.portfolioId);
  const [portfolio] = await db.select().from(schema.portfolios)
    .where(eq(schema.portfolios.id, params.portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });

  let result: Record<string, unknown>;

  if (params.kind === "multi_trade") {
    if (!params.legs?.length) throw Object.assign(new Error("legs required"), { status: 400 });
    const sim = await simulateTrade(params.portfolioId, params.legs);
    result = { kind: params.kind, simulation: sim, note: "Advisory what-if — no orders written" };
  } else if (params.kind === "price_shock") {
    const pct = Number(params.shockPct ?? -10);
    if (!Number.isFinite(pct)) throw Object.assign(new Error("shockPct required"), { status: 400 });
    const targetIds = new Set(
      params.stockIds?.length
        ? params.stockIds
        : holdings.filter((h) => !params.sector || h.sector === params.sector).map((h) => h.stockId),
    );
    const cash = Number(portfolio.cashBalance ?? 0);
    let equityAfter = 0;
    const impacts = [];
    for (const h of holdings) {
      const shocked = targetIds.has(h.stockId) ? h.currentPrice * (1 + pct / 100) : h.currentPrice;
      const mv = h.quantity * shocked;
      equityAfter += mv;
      if (targetIds.has(h.stockId)) {
        impacts.push({
          stockId: h.stockId,
          ticker: h.ticker,
          priceBefore: h.currentPrice,
          priceAfter: round4(shocked),
          valueBefore: round4(h.currentValue),
          valueAfter: round4(mv),
          pnl: round4(mv - h.currentValue),
        });
      }
    }
    const navBefore = holdings.reduce((s, h) => s + h.currentValue, 0) + cash;
    const navAfter = round4(equityAfter + cash);
    const weights = holdings.map((h) => {
      const shocked = targetIds.has(h.stockId) ? h.currentPrice * (1 + pct / 100) : h.currentPrice;
      const mv = h.quantity * shocked;
      return { stockId: h.stockId, weight: navAfter > 0 ? round4(mv / navAfter) : 0 };
    });
    const compliance = await runCompliance({
      portfolioId: params.portfolioId,
      targetWeights: weights,
      persist: false,
      timing: "before_trade",
    });
    result = {
      kind: params.kind,
      shockPct: pct,
      navBefore: round4(navBefore),
      navAfter,
      pnl: round4(navAfter - navBefore),
      impacts,
      compliance,
      note: "Price shock scenario — no executions",
    };
  } else if (params.kind === "liquidity_stress") {
    const legs = params.legs ?? [];
    const stockIds = legs.map((l) => l.stockId);
    const stocks = stockIds.length
      ? await db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
      : [];
    const stockMap = new Map(stocks.map((s) => [s.id, s]));
    const flags = [];
    for (const leg of legs) {
      const s = stockMap.get(leg.stockId);
      if (!s) continue;
      const adtv = s.avgDailyTradedValue != null ? Number(s.avgDailyTradedValue) : null;
      const price = holdings.find((h) => h.stockId === leg.stockId)?.currentPrice
        ?? (leg.price != null ? Number(leg.price) : 0);
      const notional = leg.quantity * price;
      const ratio = adtv && adtv > 0 ? notional / adtv : null;
      flags.push({
        ticker: s.ticker,
        notional: round4(notional),
        adtv,
        isIlliquid: s.isIlliquid,
        daysOfAdtv: ratio,
        flag: s.isIlliquid || (ratio != null && ratio > 0.2) || (adtv != null && adtv < 100_000),
      });
    }
    const sim = legs.length ? await simulateTrade(params.portfolioId, legs) : null;
    result = {
      kind: params.kind,
      flags,
      simulation: sim,
      note: "Liquidity stress — flags only; Phase 1 illiquid threshold QAR 100,000 ADTV",
    };
  } else if (params.kind === "cash_deploy") {
    const cash = Number(portfolio.cashBalance ?? 0);
    const equity = holdings.reduce((s, h) => s + h.currentValue, 0);
    const nav = cash + equity;
    const excess = nav > 0 ? cash / nav : 0;
    result = {
      kind: params.kind,
      cash,
      nav: round4(nav),
      cashWeight: round4(excess),
      suggestion: excess > 0.05
        ? "Excess cash above 5% of NAV — consider Builder model targets (draft only)."
        : "Cash weight within common excess-cash soft band.",
      note: "Cash deployment suggestion is advisory; use Builder for draft targets.",
    };
  } else {
    // benchmark_relative — active weight estimate vs current (no invented index weights)
    const nav = holdings.reduce((s, h) => s + h.currentValue, 0) + Number(portfolio.cashBalance ?? 0);
    const active = holdings.map((h) => ({
      ticker: h.ticker,
      portfolioWeight: nav > 0 ? round4(h.currentValue / nav) : 0,
      benchmarkWeight: null as null,
      activeWeight: null as null,
      note: "UNKNOWN — historical index constituent weights not in KB; cannot invent active weights",
    }));
    result = {
      kind: params.kind,
      holdings: active,
      note: "Benchmark-relative active weights UNKNOWN until index weight pack is sourced.",
    };
  }

  let saved = null;
  if (params.persist !== false) {
    const [row] = await db.insert(schema.scenarioRuns).values({
      name: params.name ?? `${params.kind} ${new Date().toISOString().slice(0, 16)}`,
      kind: params.kind,
      portfolioId: params.portfolioId,
      params: {
        legs: params.legs,
        shockPct: params.shockPct,
        stockIds: params.stockIds,
        sector: params.sector,
      },
      result,
      createdBy: params.userId ?? null,
    }).returning();
    saved = row;
    await writeAudit({
      userId: params.userId,
      action: "create",
      objectType: "scenario_run",
      objectId: row.id,
      newValue: { kind: params.kind },
    });
  }

  return { scenario: saved, result };
}

export async function listScenarios(portfolioId?: string) {
  if (portfolioId) {
    return db.select().from(schema.scenarioRuns)
      .where(eq(schema.scenarioRuns.portfolioId, portfolioId))
      .orderBy(desc(schema.scenarioRuns.createdAt));
  }
  return db.select().from(schema.scenarioRuns).orderBy(desc(schema.scenarioRuns.createdAt)).limit(100);
}
