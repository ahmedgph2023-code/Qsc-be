import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { getPortfolioHoldings } from "./calculations.js";
import { isStockEligible } from "./mandate-rules.js";
import { getApprovedListStatus } from "./research-engine.js";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";
import { writeAudit } from "./audit.js";

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Advisory Efficient Frontier / constrained allocation candidate.
 * Methodology is explicitly UNCONFIRMED (REQUIRES CONFIRMATION with Investment).
 * Does not create OMS orders. Builder handoff is draft payload only.
 */
export async function runEfficientFrontier(params: {
  portfolioId: string;
  maxNames?: number;
  userId?: string;
}) {
  const [portfolio] = await db.select().from(schema.portfolios)
    .where(eq(schema.portfolios.id, params.portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });

  const [mandate] = await db.select().from(schema.mandates)
    .where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1);
  if (!mandate || mandate.approvalStatus !== "approved") {
    throw Object.assign(new Error("Approved mandate required"), { status: 403 });
  }

  const holdings = await getPortfolioHoldings(params.portfolioId);
  const cash = Number(portfolio.cashBalance ?? 0);
  const equity = holdings.reduce((s, h) => s + h.currentValue, 0);
  const nav = cash + equity;

  const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.instrumentType, "equity"));
  const eligible = [];
  for (const s of stocks) {
    if (s.isIlliquid) continue;
    const elig = await isStockEligible({
      shariahPreference: mandate.shariahPreference,
      stockId: s.id,
      mandateId: mandate.id,
    });
    if (!elig.allowed) continue;
    const al = await getApprovedListStatus(s.id);
    if (al === "restricted" || al === "sell_only" || al === "hold") continue;
    eligible.push(s);
  }

  if (eligible.length < 2) {
    const blocked = {
      status: "blocked",
      reasonCode: "UNIVERSE_TOO_SMALL",
      message: "Eligible universe too small after mandate / Approved List / liquidity filters",
      methodology: "unconfirmed_equal_risk",
      assumptions: {
        confirmation: "REQUIRES CONFIRMATION — mean-variance methodology not product-approved",
        advisoryOnly: true,
      },
    };
    const [row] = await db.insert(schema.efficientFrontierRuns).values({
      portfolioId: params.portfolioId,
      mandateId: mandate.id,
      methodology: "unconfirmed_equal_risk",
      assumptions: blocked.assumptions,
      params: { maxNames: params.maxNames },
      result: blocked,
      status: "blocked",
      createdBy: params.userId ?? null,
    }).returning();
    return { run: row, ...blocked };
  }

  const stockCap = IPS_LIMIT_FALLBACKS.stockSoft;
  const maxNames = Math.min(params.maxNames ?? 15, eligible.length);
  // Prefer names already held, then fill from eligible universe
  const heldIds = new Set(holdings.map((h) => h.stockId));
  const ordered = [
    ...eligible.filter((s) => heldIds.has(s.id)),
    ...eligible.filter((s) => !heldIds.has(s.id)),
  ].slice(0, maxNames);

  const raw = 1 / ordered.length;
  const weight = Math.min(raw, stockCap);
  const scale = weight * ordered.length;
  const targets = ordered.map((s) => ({
    stockId: s.id,
    ticker: s.ticker,
    sector: s.sector,
    weight: round4(weight / (scale || 1)),
  }));
  // renormalize to 1
  const sum = targets.reduce((s, t) => s + t.weight, 0) || 1;
  for (const t of targets) t.weight = round4(t.weight / sum);

  const current = holdings.map((h) => ({
    stockId: h.stockId,
    ticker: h.ticker,
    weight: nav > 0 ? round4(h.currentValue / nav) : 0,
  }));

  const builderDraft = {
    status: "draft",
    holdings: targets.map((t) => ({ stockId: t.stockId, weight: t.weight, sleeve: "core" as const })),
    note: "Draft only — send to Builder manually; compliance still required",
  };

  const result = {
    status: "completed",
    advisoryOnly: true,
    methodology: "unconfirmed_equal_risk",
    confirmation: "REQUIRES CONFIRMATION — not a product-approved mean-variance frontier",
    assumptions: {
      equalWeightWithinIpsSoftCap: true,
      stockSoftCap: stockCap,
      excluded: ["illiquid", "ineligible", "restricted", "sell_only", "hold"],
      covariance: "UNKNOWN — full MV frontier blocked until Investment confirms methodology + stats pack",
    },
    universeSize: eligible.length,
    selectedNames: targets.length,
    current,
    proposed: targets,
    builderDraft,
    compareNav: round4(nav),
  };

  const [row] = await db.insert(schema.efficientFrontierRuns).values({
    portfolioId: params.portfolioId,
    mandateId: mandate.id,
    methodology: "unconfirmed_equal_risk",
    assumptions: result.assumptions,
    params: { maxNames },
    result,
    status: "completed",
    createdBy: params.userId ?? null,
  }).returning();

  await writeAudit({
    userId: params.userId,
    action: "create",
    objectType: "efficient_frontier_run",
    objectId: row.id,
    newValue: { methodology: result.methodology, names: targets.length },
  });

  return { run: row, ...result };
}

export async function listFrontierRuns(portfolioId?: string) {
  if (portfolioId) {
    return db.select().from(schema.efficientFrontierRuns)
      .where(eq(schema.efficientFrontierRuns.portfolioId, portfolioId))
      .orderBy(desc(schema.efficientFrontierRuns.createdAt));
  }
  return db.select().from(schema.efficientFrontierRuns)
    .orderBy(desc(schema.efficientFrontierRuns.createdAt)).limit(50);
}
