import { and, asc, eq, lte } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { tryEvaluateFormula } from "../lib/formula-eval.js";
import { getFormulaMap } from "./portfolio-formulas.js";

function toNum(v: unknown): number {
  return Number(v ?? 0);
}

function ymd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

export function indexLevelReturn(startLevel: number, asOfLevel: number): number | null {
  if (!(startLevel > 0) || !Number.isFinite(asOfLevel)) return null;
  return asOfLevel / startLevel - 1;
}

export async function getFirstActivityDate(portfolioId: string): Promise<string | null> {
  const [cash] = await db.select({ d: schema.cashTransactions.tradeDate })
    .from(schema.cashTransactions)
    .where(eq(schema.cashTransactions.portfolioId, portfolioId))
    .orderBy(asc(schema.cashTransactions.tradeDate))
    .limit(1);
  const [tx] = await db.select({ t: schema.transactions.timestamp })
    .from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp))
    .limit(1);
  const cashD = cash?.d ? ymd(cash.d) : null;
  const txD = tx?.t ? ymd(tx.t) : null;
  if (cashD && txD) return cashD < txD ? cashD : txD;
  return cashD || txD;
}

export async function resolvePortfolioBenchmark(portfolioId: string): Promise<{
  indexId: string;
  indexName: string;
} | null> {
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolio) return null;

  const [mandate] = await db.select().from(schema.mandates)
    .where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1);

  const wantedId = mandate?.benchmarkIndexId || portfolio.benchmarkIndexId;
  if (wantedId) {
    const [idx] = await db.select().from(schema.indices).where(eq(schema.indices.id, wantedId)).limit(1);
    if (idx) return { indexId: idx.id, indexName: idx.name };
  }

  const shariah = mandate?.shariahPreference === "fully_shariah";
  const names = shariah ? ["QERI", "QE Al Rayan"] : ["DSM", "QE Index", "QE General"];
  const all = await db.select().from(schema.indices);
  const found = all.find((i) => names.some((n) => i.name.toUpperCase().includes(n.toUpperCase())));
  if (!found) return null;
  return { indexId: found.id, indexName: found.name };
}

async function indexLevelOnOrBefore(indexId: string, date: string): Promise<{ date: string; value: number } | null> {
  const rows = await db.select({ date: schema.indexDataPoints.date, value: schema.indexDataPoints.value })
    .from(schema.indexDataPoints)
    .where(and(eq(schema.indexDataPoints.indexId, indexId), lte(schema.indexDataPoints.date, date)))
    .orderBy(asc(schema.indexDataPoints.date));
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { date: last.date, value: toNum(last.value) };
}

export async function getExcelIndexPerformance(portfolioId: string, asOf?: string) {
  const bench = await resolvePortfolioBenchmark(portfolioId);
  if (!bench) return null;
  const start = await getFirstActivityDate(portfolioId);
  if (!start) return null;
  const end = asOf || new Date().toISOString().slice(0, 10);
  const startPt = await indexLevelOnOrBefore(bench.indexId, start);
  const endPt = await indexLevelOnOrBefore(bench.indexId, end);
  if (!startPt || !endPt) return null;

  const formulas = await getFormulaMap();
  const fallback = indexLevelReturn(startPt.value, endPt.value);
  const ratio = formulas.index_performance
    ? tryEvaluateFormula(formulas.index_performance, { asOfLevel: endPt.value, startLevel: startPt.value }, fallback)
    : fallback;
  return {
    indexName: bench.indexName,
    fromDate: start,
    toDate: end,
    startLevel: startPt.value,
    asOfLevel: endPt.value,
    returnPct: ratio == null ? null : Math.round(ratio * 1_000_000) / 10_000,
  };
}

export type NavDailyPoint = {
  date: string;
  nav: number;
  chgQar: number | null;
  chgPct: number | null;
};

export function buildNavDailyPoints(
  equityHist: Array<{ date: string; value: number }>,
  cashOnDate: (date: string) => number,
  formulas: Record<string, string>,
  limit = 120,
): NavDailyPoint[] {
  const points: NavDailyPoint[] = [];
  let prevNav: number | null = null;
  for (const p of equityHist) {
    const cash = cashOnDate(p.date);
    const nav = Math.round((p.value + cash) * 10000) / 10000;
    let chgQar: number | null = null;
    let chgPct: number | null = null;
    if (prevNav != null) {
      chgQar = formulas.daily_chg_qar
        ? tryEvaluateFormula(formulas.daily_chg_qar, { nav, prevNav }, nav - prevNav)
        : nav - prevNav;
      chgPct = prevNav !== 0
        ? (formulas.daily_chg_pct
          ? tryEvaluateFormula(formulas.daily_chg_pct, { nav, prevNav }, (nav - prevNav) / prevNav)
          : (nav - prevNav) / prevNav)
        : null;
      if (chgQar != null) chgQar = Math.round(chgQar * 10000) / 10000;
      if (chgPct != null) chgPct = Math.round(chgPct * 1_000_000) / 10_000;
    }
    points.push({ date: p.date, nav, chgQar, chgPct });
    prevNav = nav;
  }
  return points.length > limit ? points.slice(-limit) : points;
}

export function applyHoldingFormulas(
  row: { quantity: number; avgCost: number; currentPrice: number; totalCost: number },
  formulas: Record<string, string>,
) {
  const equityDefault = row.quantity * row.currentPrice;
  const costDefault = row.totalCost;
  const equity = formulas.equity_value
    ? tryEvaluateFormula(formulas.equity_value, { shares: row.quantity, price: row.currentPrice }, equityDefault) ?? equityDefault
    : equityDefault;
  const totalCost = formulas.total_cost
    ? tryEvaluateFormula(formulas.total_cost, { shares: row.quantity, cost: row.avgCost }, costDefault) ?? costDefault
    : costDefault;
  const plDefault = equity - totalCost;
  const pl = formulas.profit_loss
    ? tryEvaluateFormula(formulas.profit_loss, { equity, totalCost }, plDefault) ?? plDefault
    : plDefault;
  return {
    currentValue: Math.round(equity * 10000) / 10000,
    totalCost: Math.round(totalCost * 10000) / 10000,
    gainLossValue: Math.round(pl * 10000) / 10000,
  };
}
