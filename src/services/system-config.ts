import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { parseShariahGroupInput } from "./mandate-rules.js";
import { writeAudit } from "./audit.js";

export const DEFAULT_IPS_LIMITS = [
  { key: "stock_soft_weight", value: "0.15", unit: "ratio", description: "Single stock soft limit 15% — notify / block extra buy" },
  { key: "stock_hard_weight", value: "0.20", unit: "ratio", description: "Single stock hard limit 20% — reduce to soft within days" },
  { key: "sector_soft_weight", value: "0.35", unit: "ratio", description: "Sector soft limit 35% — block more buys" },
  { key: "sector_hard_weight", value: "0.40", unit: "ratio", description: "Sector hard limit 40% — reduce to soft within days" },
  { key: "loss_15", value: "-0.15", unit: "ratio", description: "Stock loss −15% vs cost — review" },
  { key: "loss_25", value: "-0.25", unit: "ratio", description: "Stock loss −25% vs cost — exit plan" },
  { key: "loss_30", value: "-0.30", unit: "ratio", description: "Stock loss −30% vs cost — urgent" },
  { key: "underperform_3m", value: "-0.05", unit: "ratio", description: "Underperform vs benchmark >5% over 3m" },
  { key: "excess_cash_ratio", value: "0.10", unit: "ratio", description: "Excess cash soft band" },
  { key: "days_reduce_stock_20", value: "10", unit: "days", description: "Trading days to reduce stock >20% to 15%" },
  { key: "days_reduce_sector_40", value: "5", unit: "days", description: "Trading days to reduce sector >40% to 35%" },
  { key: "adtv_illiquid", value: "100000", unit: "qar", description: "ADTV below this → illiquid flag (Phase 1)" },
] as const;

export const DEFAULT_SYSTEM_SETTINGS = [
  {
    key: "illiquid_hard_block",
    value: "false",
    valueType: "boolean",
    category: "liquidity",
    description: "If true, illiquid stocks fail eligibility (hard block). If false, warning only (Blueprint Phase 1 default).",
    confirmed: false,
    source: "blueprint_default",
  },
  {
    key: "research_gate_hard_block",
    value: "true",
    valueType: "boolean",
    category: "research",
    description: "If true, Builder convert blocks when satellite five-layer gate fails (unless exception).",
    confirmed: false,
    source: "phase3_default",
  },
  {
    key: "approved_list_enforce",
    value: "true",
    valueType: "boolean",
    category: "research",
    description: "If true, compliance applies Approved List checks on net buys.",
    confirmed: false,
    source: "phase3_default",
  },
  {
    key: "shariah_model",
    value: "binary",
    valueType: "string",
    category: "shariah",
    description: "Product Shariah model in use: binary (shariah|not_shariah). A/B/C requires BD-001 confirmation — do not switch without Investment sign-off.",
    confirmed: false,
    source: "implemented_0008",
  },
] as const;

export async function ensureSystemConfigDefaults() {
  const existingIps = await db.select({ key: schema.ipsLimitConfig.key }).from(schema.ipsLimitConfig);
  const ipsKeys = new Set(existingIps.map((r) => r.key));
  for (const row of DEFAULT_IPS_LIMITS) {
    if (!ipsKeys.has(row.key)) {
      await db.insert(schema.ipsLimitConfig).values(row);
    }
  }

  const existingSettings = await db.select({ key: schema.systemSettings.key }).from(schema.systemSettings);
  const setKeys = new Set(existingSettings.map((r) => r.key));
  for (const row of DEFAULT_SYSTEM_SETTINGS) {
    if (!setKeys.has(row.key)) {
      await db.insert(schema.systemSettings).values(row);
    }
  }
}

export async function getSystemSetting(key: string): Promise<string | null> {
  await ensureSystemConfigDefaults();
  const rows = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function getSystemFlag(key: string, fallback = false): Promise<boolean> {
  const v = await getSystemSetting(key);
  if (v == null) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

export async function getBundle() {
  await ensureSystemConfigDefaults();
  const ips = await db.select().from(schema.ipsLimitConfig).orderBy(asc(schema.ipsLimitConfig.key));
  const settings = await db.select().from(schema.systemSettings).orderBy(asc(schema.systemSettings.key));
  return {
    ipsLimits: ips,
    settings,
    note: "Changes apply immediately to compliance / risk / eligibility / Builder gates. Super Admin only.",
  };
}

export async function updateIpsLimit(params: {
  key: string;
  value: number | string;
  description?: string;
  userId?: string;
}) {
  await ensureSystemConfigDefaults();
  const [existing] = await db.select().from(schema.ipsLimitConfig)
    .where(eq(schema.ipsLimitConfig.key, params.key)).limit(1);
  if (!existing) throw Object.assign(new Error(`Unknown IPS key: ${params.key}`), { status: 404 });

  const value = String(params.value);
  if (!Number.isFinite(Number(value))) {
    throw Object.assign(new Error("value must be numeric"), { status: 400 });
  }

  const [row] = await db.update(schema.ipsLimitConfig).set({
    value,
    ...(params.description != null ? { description: params.description } : {}),
  }).where(eq(schema.ipsLimitConfig.key, params.key)).returning();

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "ips_limit_config",
    objectId: params.key,
    oldValue: { value: existing.value },
    newValue: { value: row.value },
    reason: "Super Admin system config",
  });

  if (params.key === "adtv_illiquid") {
    await refreshIlliquidFlagsFromAdtv(params.userId);
  }

  return row;
}

export async function updateSystemSetting(params: {
  key: string;
  value: string | boolean;
  confirmed?: boolean;
  userId?: string;
}) {
  await ensureSystemConfigDefaults();
  const [existing] = await db.select().from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, params.key)).limit(1);
  if (!existing) throw Object.assign(new Error(`Unknown setting: ${params.key}`), { status: 404 });

  if (params.key === "shariah_model" && String(params.value) !== "binary") {
    throw Object.assign(
      new Error("shariah_model other than binary REQUIRES BD-001 confirmation — keep binary until Investment signs off"),
      { status: 400 },
    );
  }

  let value = String(params.value);
  if (existing.valueType === "boolean") {
    value = (params.value === true || value === "true" || value === "1") ? "true" : "false";
  }

  const [row] = await db.update(schema.systemSettings).set({
    value,
    confirmed: params.confirmed ?? existing.confirmed,
    updatedBy: params.userId ?? null,
    updatedAt: new Date(),
  }).where(eq(schema.systemSettings.key, params.key)).returning();

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "system_setting",
    objectId: params.key,
    oldValue: { value: existing.value, confirmed: existing.confirmed },
    newValue: { value: row.value, confirmed: row.confirmed },
    reason: "Super Admin system config",
  });

  return row;
}

export async function listUniverseForAdmin() {
  const stocks = await db.select({
    id: schema.stocks.id,
    ticker: schema.stocks.ticker,
    companyName: schema.stocks.companyName,
    sector: schema.stocks.sector,
    shariahGroup: schema.stocks.shariahGroup,
    isIlliquid: schema.stocks.isIlliquid,
    avgDailyTradedValue: schema.stocks.avgDailyTradedValue,
    regulatoryStatus: schema.stocks.regulatoryStatus,
    isTradable: schema.stocks.isTradable,
    isQeriMember: schema.stocks.isQeriMember,
    isDsmMember: schema.stocks.isDsmMember,
  }).from(schema.stocks)
    .where(eq(schema.stocks.instrumentType, "equity"))
    .orderBy(asc(schema.stocks.ticker));

  const approved = await db.select().from(schema.stockApprovedList);
  const approvedMap = new Map(approved.map((a) => [a.stockId, a.status]));

  return stocks.map((s) => ({
    ...s,
    avgDailyTradedValue: s.avgDailyTradedValue != null ? Number(s.avgDailyTradedValue) : null,
    approvedListStatus: approvedMap.get(s.id) ?? "watchlist",
  }));
}

export async function updateStockClassification(params: {
  stockId: string;
  shariahGroup?: string | null;
  isIlliquid?: boolean;
  isTradable?: boolean;
  regulatoryStatus?: string;
  userId?: string;
}) {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (params.shariahGroup !== undefined) {
    patch.shariahGroup = parseShariahGroupInput(params.shariahGroup);
  }
  if (params.isIlliquid !== undefined) patch.isIlliquid = params.isIlliquid;
  if (params.isTradable !== undefined) patch.isTradable = params.isTradable;
  if (params.regulatoryStatus !== undefined) patch.regulatoryStatus = params.regulatoryStatus;

  const [row] = await db.update(schema.stocks).set(patch)
    .where(eq(schema.stocks.id, params.stockId)).returning();
  if (!row) throw Object.assign(new Error("Stock not found"), { status: 404 });

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "stock_classification",
    objectId: row.id,
    newValue: {
      ticker: row.ticker,
      shariahGroup: row.shariahGroup,
      isIlliquid: row.isIlliquid,
      isTradable: row.isTradable,
      regulatoryStatus: row.regulatoryStatus,
    },
    reason: "Super Admin universe config",
  });

  return row;
}

/** Recompute is_illiquid from ADTV vs ips adtv_illiquid threshold. */
export async function refreshIlliquidFlagsFromAdtv(userId?: string) {
  await ensureSystemConfigDefaults();
  const [lim] = await db.select().from(schema.ipsLimitConfig)
    .where(eq(schema.ipsLimitConfig.key, "adtv_illiquid")).limit(1);
  const threshold = lim ? Number(lim.value) : 100_000;

  const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.instrumentType, "equity"));
  let updated = 0;
  for (const s of stocks) {
    const adtv = s.avgDailyTradedValue != null ? Number(s.avgDailyTradedValue) : null;
    const next = adtv != null ? adtv < threshold : s.isIlliquid;
    if (next !== s.isIlliquid && adtv != null) {
      await db.update(schema.stocks).set({ isIlliquid: next, updatedAt: new Date() })
        .where(eq(schema.stocks.id, s.id));
      updated += 1;
    }
  }

  await writeAudit({
    userId,
    action: "update",
    objectType: "illiquid_refresh",
    objectId: "adtv_illiquid",
    newValue: { threshold, stocksUpdated: updated },
    reason: "Recompute illiquid flags from ADTV threshold",
  });

  return { threshold, stocksUpdated: updated };
}
