import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { evaluateFormula } from "../lib/formula-eval.js";
import { writeAudit } from "./audit.js";

export type FormulaCategory = "kpi" | "row" | "cash" | "daily";

/** Whitelist of engine variables the Super Admin may pick (no free-text names). */
export const FORMULA_COLUMNS = [
  { id: "shares", source: "holdings.quantity" },
  { id: "price", source: "stock_prices.price" },
  { id: "cost", source: "holdings.avg_cost" },
  { id: "cash", source: "cash_transactions.balance" },
  { id: "equity", source: "holdings.current_value" },
  { id: "totalCost", source: "holdings.total_cost" },
  { id: "totalEquity", source: "excelWorkbook.equityValue" },
  { id: "return", source: "holdings.holding_return" },
  { id: "holdingDays", source: "holdings.holding_days" },
  { id: "rowPnL", source: "holdings.gain_loss_value" },
  { id: "totalPnL", source: "sum(holdings.gain_loss_value)" },
  { id: "asOfLevel", source: "index_data_points.value" },
  { id: "startLevel", source: "index_data_points.value" },
  { id: "nav", source: "portfolios.nav" },
  { id: "prevNav", source: "portfolios.nav_prev_close" },
] as const;

export type FormulaDef = {
  key: string;
  label: string;
  category: FormulaCategory;
  excelFormula: string;
  expression: string;
  inputs: string[];
  description: string;
};

export const DEFAULT_PORTFOLIO_FORMULAS: FormulaDef[] = [
  {
    key: "equity_value",
    label: "Equity value",
    category: "row",
    excelFormula: "Table1[[#This Row],[shares]]*Table1[[#This Row],[price]]",
    expression: "shares * price",
    inputs: ["shares", "price"],
    description: "Market value of the holding. Cash uses price = 1.",
  },
  {
    key: "total_cost",
    label: "Total cost",
    category: "row",
    excelFormula: "Table1[[#This Row],[shares]]*Table1[[#This Row],[cost]]",
    expression: "shares * cost",
    inputs: ["shares", "cost"],
    description: "Open-lot weighted average cost × shares. Cash row uses cash_total_cost instead.",
  },
  {
    key: "cash_total_cost",
    label: "Cash total cost",
    category: "cash",
    excelFormula: "Table1[[#This Row],[shares]]",
    expression: "cash",
    inputs: ["cash"],
    description: "Excel Cash row: Total cost = shares (cash amount), not shares × cost.",
  },
  {
    key: "profit_loss",
    label: "Profit / Loss",
    category: "row",
    excelFormula: "Table1[[#This Row],[Equity value]]-H{row}",
    expression: "equity - totalCost",
    inputs: ["equity", "totalCost"],
    description: "Unrealized P/L. Cash is 0 because equity = total cost.",
  },
  {
    key: "weight",
    label: "Weight %",
    category: "row",
    excelFormula: "Table1[[#This Row],[Equity value]]/Table1[[#Totals],[Equity value]]",
    expression: "equity / totalEquity",
    inputs: ["equity", "totalEquity"],
    description: "Weight of this asset in Portfolio Value (stocks + cash).",
  },
  {
    key: "holding_return",
    label: "Return",
    category: "row",
    excelFormula: "Table1[[#This Row],[Equity value]]/Table1[[#This Row],[Total cost]]-1",
    expression: "equity / totalCost - 1",
    inputs: ["equity", "totalCost"],
    description: "Holding simple return.",
  },
  {
    key: "annualized_return",
    label: "Annualized Return",
    category: "row",
    excelFormula: "((Table1[[#This Row],[Return]]+1)^(Table1[[#This Row],[Holding days]]/365))-1",
    expression: "((return + 1) ^ (holdingDays / 365)) - 1",
    inputs: ["return", "holdingDays"],
    description: "Excel exponent (days/365), not CFA 365/days.",
  },
  {
    key: "return_contribution",
    label: "Return Contribution",
    category: "row",
    excelFormula: "Table1[[#This Row],[Profit/ Loss]]/Table1[[#Totals],[Profit/ Loss]]",
    expression: "rowPnL / totalPnL",
    inputs: ["rowPnL", "totalPnL"],
    description: "Row P/L ÷ total P/L. Undefined when total P/L is 0.",
  },
  {
    key: "portfolio_value",
    label: "Portfolio Value",
    category: "kpi",
    excelFormula: "Table1[[#Totals],[Equity value]]",
    expression: "totalEquity",
    inputs: ["totalEquity"],
    description: "SUM of Equity including Cash.",
  },
  {
    key: "portfolio_growth",
    label: "Portfolio Growth",
    category: "kpi",
    excelFormula: "Table1[[#Totals],[Equity value]]/Table1[[#Totals],[Total cost]]-1",
    expression: "totalEquity / totalCost - 1",
    inputs: ["totalEquity", "totalCost"],
    description: "Includes Cash in both totals (Table1).",
  },
  {
    key: "portfolio_gain",
    label: "Portfolio QAR Gain",
    category: "kpi",
    excelFormula: "Table1[[#Totals],[Equity value]]-Table1[[#Totals],[Total cost]]",
    expression: "totalEquity - totalCost",
    inputs: ["totalEquity", "totalCost"],
    description: "Includes Cash (Cash P/L = 0).",
  },
  {
    key: "index_performance",
    label: "Index Performance",
    category: "kpi",
    excelFormula: "(typed in sample workbook J4 — no live formula)",
    expression: "asOfLevel / startLevel - 1",
    inputs: ["asOfLevel", "startLevel"],
    description: "Mandate benchmark level change from first funding/trade date to as-of (price return of the index).",
  },
  {
    key: "daily_chg_qar",
    label: "Daily Chg. (QAR)",
    category: "daily",
    excelFormula: "B{n}-B{n-1}",
    expression: "nav - prevNav",
    inputs: ["nav", "prevNav"],
    description: "Sheet2 daily change in portfolio value.",
  },
  {
    key: "daily_chg_pct",
    label: "Daily Chg. %",
    category: "daily",
    excelFormula: "C{n}/B{n-1}",
    expression: "(nav - prevNav) / prevNav",
    inputs: ["nav", "prevNav"],
    description: "Sheet2 daily change percent.",
  },
];

export async function ensurePortfolioFormulaDefaults() {
  const existing = await db.select({ key: schema.portfolioFormulas.key }).from(schema.portfolioFormulas);
  const keys = new Set(existing.map((r) => r.key));
  for (const row of DEFAULT_PORTFOLIO_FORMULAS) {
    if (keys.has(row.key)) continue;
    await db.insert(schema.portfolioFormulas).values({
      key: row.key,
      label: row.label,
      category: row.category,
      excelFormula: row.excelFormula,
      expression: row.expression,
      inputs: row.inputs,
      description: row.description,
    });
  }
}

export async function listPortfolioFormulas() {
  await ensurePortfolioFormulaDefaults();
  return db.select().from(schema.portfolioFormulas).orderBy(asc(schema.portfolioFormulas.category), asc(schema.portfolioFormulas.key));
}

/** key → expression. Empty object if the table is not migrated yet. */
export async function getFormulaMap(): Promise<Record<string, string>> {
  try {
    await ensurePortfolioFormulaDefaults();
    const rows = await db.select({ key: schema.portfolioFormulas.key, expression: schema.portfolioFormulas.expression })
      .from(schema.portfolioFormulas);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.expression;
    return map;
  } catch {
    const map: Record<string, string> = {};
    for (const row of DEFAULT_PORTFOLIO_FORMULAS) map[row.key] = row.expression;
    return map;
  }
}

export async function updatePortfolioFormula(params: {
  key: string;
  expression: string;
  userId?: string;
}) {
  await ensurePortfolioFormulaDefaults();
  const [existing] = await db.select().from(schema.portfolioFormulas)
    .where(eq(schema.portfolioFormulas.key, params.key)).limit(1);
  if (!existing) throw Object.assign(new Error(`Unknown formula key: ${params.key}`), { status: 404 });

  const expression = String(params.expression || "").trim();
  if (!expression) throw Object.assign(new Error("expression is required"), { status: 400 });

  const sample: Record<string, number> = {};
  for (const name of existing.inputs || []) sample[name] = 1;
  if ("totalPnL" in sample) sample.totalPnL = 1;
  if ("prevNav" in sample) sample.prevNav = 1;
  try {
    evaluateFormula(expression, sample);
  } catch (e) {
    throw Object.assign(new Error(e instanceof Error ? e.message : "Invalid formula"), { status: 400 });
  }

  const [row] = await db.update(schema.portfolioFormulas).set({
    expression,
    updatedBy: params.userId || null,
    updatedAt: new Date(),
  }).where(eq(schema.portfolioFormulas.key, params.key)).returning();

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "portfolio_formula",
    objectId: params.key,
    oldValue: { expression: existing.expression },
    newValue: { expression },
  });
  return row;
}
