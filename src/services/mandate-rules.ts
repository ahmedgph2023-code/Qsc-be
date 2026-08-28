import { db, schema } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { getSystemFlag } from "./system-config.js";

export type ShariahPreference = "fully_shariah" | "unrestricted";
export type ShariahStatus = "shariah" | "not_shariah";
export type RiskProfile = "medium" | "high";

const MODEL_CODE: Record<`${ShariahPreference}:${RiskProfile}`, string> = {
  "fully_shariah:medium": "FS_MED",
  "fully_shariah:high": "FS_HIGH",
  "unrestricted:medium": "UN_MED",
  "unrestricted:high": "UN_HIGH",
};

/** Map legacy A/B/C (and aliases) onto the binary classification. */
export function normalizeShariahGroup(raw?: string | null): ShariahStatus | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === "shariah" || v === "a" || v === "yes" || v === "y") return "shariah";
  if (v === "not_shariah" || v === "not shariah" || v === "b" || v === "c" || v === "no" || v === "n") return "not_shariah";
  return null;
}

export function parseShariahGroupInput(raw: unknown): ShariahStatus | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const normalized = normalizeShariahGroup(String(raw));
  if (!normalized) {
    throw new Error("shariahGroup must be shariah or not_shariah");
  }
  return normalized;
}

export function shariahGroupLabel(raw?: string | null): string {
  const n = normalizeShariahGroup(raw);
  if (n === "shariah") return "Shariah";
  if (n === "not_shariah") return "Not Shariah";
  return "Unclassified";
}

/** Treat leftover purifying mandates as unrestricted (they could previously hold group B). */
export function normalizePreference(pref?: string | null): ShariahPreference {
  if (pref === "unrestricted" || pref === "shariah_purifying") return "unrestricted";
  return "fully_shariah";
}

export function allowedGroups(pref: string | ShariahPreference): ShariahStatus[] {
  if (normalizePreference(pref) === "fully_shariah") return ["shariah"];
  return ["shariah", "not_shariah"];
}

export function universeLabel(pref: string | ShariahPreference): string {
  return normalizePreference(pref) === "fully_shariah" ? "Shariah only" : "Shariah and Not Shariah";
}

export function modelCodeFor(pref: ShariahPreference, risk: RiskProfile): string {
  return MODEL_CODE[`${normalizePreference(pref)}:${risk}`];
}

export function benchmarkNameFor(pref: ShariahPreference): "QERI" | "DSM" {
  return normalizePreference(pref) === "unrestricted" ? "DSM" : "QERI";
}

export async function findModelByMandate(pref: ShariahPreference, risk: RiskProfile) {
  const code = modelCodeFor(pref, risk);
  const rows = await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, code)).limit(1);
  return rows[0] ?? null;
}

export async function findBenchmarkIndex(pref: ShariahPreference) {
  const name = benchmarkNameFor(pref);
  const rows = await db.select().from(schema.indices).where(eq(schema.indices.name, name)).limit(1);
  if (rows[0]) return rows[0];
  const all = await db.select().from(schema.indices);
  return all.find((i) => i.name.toUpperCase().includes(name)) ?? null;
}

export async function isStockEligible(params: {
  shariahPreference: string | ShariahPreference;
  stockId: string;
  mandateId?: string;
}): Promise<{ allowed: boolean; reasons: string[]; stock?: typeof schema.stocks.$inferSelect }> {
  const reasons: string[] = [];
  const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.id, params.stockId)).limit(1);
  if (!stocks[0]) return { allowed: false, reasons: ["STOCK_NOT_FOUND"] };
  const s = stocks[0];
  const pref = normalizePreference(params.shariahPreference);
  const status = normalizeShariahGroup(s.shariahGroup);

  if (!s.isTradable) reasons.push("NOT_TRADABLE");
  if (s.regulatoryStatus === "restricted" || s.regulatoryStatus === "suspended") reasons.push("REGULATORY");
  if (!status) reasons.push("UNCLASSIFIED");
  else if (!allowedGroups(pref).includes(status)) reasons.push("SHARIAH_UNIVERSE");

  if (params.mandateId) {
    const restrictions = await db.select().from(schema.mandateRestrictions).where(
      and(eq(schema.mandateRestrictions.mandateId, params.mandateId), eq(schema.mandateRestrictions.isActive, true))
    );
    for (const r of restrictions) {
      if (r.restrictionType === "stock" && r.stockId === s.id) reasons.push("RESTRICTION_STOCK");
      if (r.restrictionType === "sector" && r.sector && r.sector.toLowerCase() === s.sector.toLowerCase()) {
        reasons.push("RESTRICTION_SECTOR");
      }
    }
  }

  if (s.isIlliquid) reasons.push("ILLIQUID_WARNING");

  const hardBlockIlliquid = await getSystemFlag("illiquid_hard_block", false);
  const hard = reasons.filter((r) => {
    if (r === "ILLIQUID_WARNING") return hardBlockIlliquid;
    return true;
  });
  return { allowed: hard.length === 0, reasons, stock: s };
}

const REASON_MESSAGES: Record<string, string> = {
  STOCK_NOT_FOUND: "Stock not found",
  NOT_TRADABLE: "Stock is marked not tradable",
  REGULATORY: "Stock is regulatory restricted or suspended",
  UNCLASSIFIED: "Stock has no Shariah classification",
  SHARIAH_UNIVERSE: "Stock is not Shariah-compliant and this mandate is Fully Shariah",
  RESTRICTION_STOCK: "Stock is excluded by a mandate restriction",
  RESTRICTION_SECTOR: "Stock sector is excluded by a mandate restriction",
  ILLIQUID_WARNING: "Stock is flagged illiquid",
  MANDATE_MISSING: "Client has no mandate on file",
  MANDATE_NOT_APPROVED: "Mandate must be Approved before trading",
};

export function formatEligibilityReasons(reasons: string[], opts?: { includeWarnings?: boolean }): string {
  return reasons
    .filter((r) => opts?.includeWarnings || r !== "ILLIQUID_WARNING")
    .map((r) => REASON_MESSAGES[r] || r)
    .join("; ");
}

/**
 * Gate a portfolio trade against mandate approval + (for BUY) universe/restrictions.
 * SELL of an existing holding is allowed even if the name is now out of universe,
 * so clients can exit restricted/non-compliant positions.
 */
export async function assertTradeEligibility(params: {
  portfolioId: string;
  stockId: string;
  type: "BUY" | "SELL";
}): Promise<{
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  reasons?: string[];
  warnings?: string[];
  mandate?: typeof schema.mandates.$inferSelect;
}> {
  const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, params.portfolioId)).limit(1);
  if (!portfolios[0]) return { ok: false, status: 404, code: "PORTFOLIO_NOT_FOUND", message: "Portfolio not found" };

  const gate = await assertMandateAllowsTrading(portfolios[0].customerId);
  if (!gate.ok || !gate.mandate) {
    return {
      ok: false,
      status: 403,
      code: gate.error || "MANDATE_BLOCKED",
      message: REASON_MESSAGES[gate.error || ""] || "Trading blocked by mandate status",
      reasons: [gate.error || "MANDATE_BLOCKED"],
    };
  }

  const mandate = gate.mandate;
  if (params.type === "SELL") {
    return { ok: true, status: 200, mandate, warnings: [] };
  }

  const elig = await isStockEligible({
    shariahPreference: mandate.shariahPreference,
    stockId: params.stockId,
    mandateId: mandate.id,
  });
  const warnings = elig.reasons.filter((r) => r === "ILLIQUID_WARNING");
  if (!elig.allowed) {
    return {
      ok: false,
      status: 403,
      code: "STOCK_NOT_ELIGIBLE",
      message: formatEligibilityReasons(elig.reasons) || "Stock is not eligible for this mandate",
      reasons: elig.reasons.filter((r) => r !== "ILLIQUID_WARNING"),
      warnings,
      mandate,
    };
  }

  return { ok: true, status: 200, mandate, warnings, reasons: elig.reasons };
}

export async function assertMandateAllowsTrading(customerId: string): Promise<{ ok: boolean; mandate?: typeof schema.mandates.$inferSelect; error?: string }> {
  const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, customerId)).limit(1);
  if (!rows[0]) return { ok: false, error: "MANDATE_MISSING" };
  if (rows[0].approvalStatus !== "approved") return { ok: false, mandate: rows[0], error: "MANDATE_NOT_APPROVED" };
  return { ok: true, mandate: rows[0] };
}
