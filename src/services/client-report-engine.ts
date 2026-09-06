import { eq, asc, lte, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema/index.js";
import type { ClientReportSection } from "../db/schema/client-reports.js";
import {
  getPortfolioStatement,
  getAccountStatement,
  getRealizedSummaryStatement,
  getRealizedDetailsStatement,
  listExtClients,
} from "./ext-sql-clients.js";
import { listStoredSnapshots } from "./snapshot-recon.js";
import { todayQatar } from "./fee-engine.js";
import { writeAudit } from "./audit.js";
import {
  deliverClientReport,
  getDeliveryChannelStatus,
  mergeDeliveryConfigUpdate,
  normalizeDeliveryConfig,
  publicDeliveryConfig,
  redactDeliveryForAudit,
  type DeliveryChannelStatus,
  type PublicClientReportDeliveryConfig,
} from "./client-report-delivery.js";
import { generateClientReportPdf } from "./client-report-pdf.js";
import type { ClientReportDeliveryConfig } from "../db/schema/client-reports.js";
import { DEFAULT_CLIENT_REPORT_DELIVERY } from "../db/schema/client-reports.js";
import { isExtSqlConfigured } from "../db/mssql.js";

export const ALL_REPORT_SECTIONS: ClientReportSection[] = [
  "portfolio_statement",
  "account_statement",
  "realized_summary",
  "realized_details",
  "balance_snapshot",
  "transactions",
  "performance",
];

export type ClientReportGlobalConfig = {
  schedulingEnabled: boolean;
  dataSections: ClientReportSection[];
  frequencyType: "daily" | "custom";
  customDays: number[];
  sendTime: string;
  asOfMode: "latest" | "previous_trading_day";
  rangeDays: number;
  deliveryConfig: PublicClientReportDeliveryConfig;
  updatedAt: string | null;
};

export const DEFAULT_GLOBAL_CLIENT_REPORT: ClientReportGlobalConfig = {
  schedulingEnabled: true,
  dataSections: ["portfolio_statement", "balance_snapshot"],
  frequencyType: "daily",
  customDays: [1, 2, 3, 4, 5],
  sendTime: "09:00",
  asOfMode: "latest",
  rangeDays: 1,
  deliveryConfig: publicDeliveryConfig(DEFAULT_CLIENT_REPORT_DELIVERY),
  updatedAt: null,
};

export type EffectiveClientReportConfig = {
  extClientId: number;
  clientName: string | null;
  enabled: boolean;
  recipientEmail: string | null;
  recipientPhone: string | null;
  sourceEmail?: string | null;
  sourcePhone?: string | null;
  dataSections: ClientReportSection[];
  frequencyType: "daily" | "custom";
  customDays: number[];
  sendTime: string;
  asOfMode: "latest" | "previous_trading_day";
  rangeDays: number;
  usesGlobalSections: boolean;
};

const QATAR_TZ = "Asia/Qatar";

export type ClientReportConfigInput = {
  extClientId: number;
  clientName?: string | null;
  enabled?: boolean;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  dataSections?: ClientReportSection[];
  frequencyType?: "daily" | "custom";
  customDays?: number[];
  sendTime?: string;
  asOfMode?: "latest" | "previous_trading_day";
  rangeDays?: number;
};

export type ClientReportPayload = {
  title: string;
  generatedAt: string;
  asOf: string;
  from: string;
  to: string;
  client: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
  };
  sections: Partial<Record<ClientReportSection, unknown>>;
  sectionLabels: Record<ClientReportSection, string>;
};

function ymdInQatar(date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: QATAR_TZ });
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function parseSendTime(sendTime: string): { hour: number; minute: number } {
  const [h, m] = sendTime.split(":").map(Number);
  return { hour: Number.isFinite(h) ? h : 9, minute: Number.isFinite(m) ? m : 0 };
}

/** Weekday in Qatar: 0=Sun … 6=Sat */
function qatarWeekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function resolveAsOf(mode: string): string {
  const today = todayQatar();
  if (mode === "previous_trading_day") {
    let cur = addDaysIso(today, -1);
    for (let i = 0; i < 7; i++) {
      const wd = qatarWeekday(cur);
      if (wd !== 5 && wd !== 6) return cur;
      cur = addDaysIso(cur, -1);
    }
    return addDaysIso(today, -1);
  }
  return today;
}

function resolveRange(asOf: string, rangeDays: number): { from: string; to: string } {
  const days = Math.max(1, rangeDays);
  return { from: addDaysIso(asOf, -(days - 1)), to: asOf };
}

function shouldSendToday(frequencyType: "daily" | "custom", customDays: number[], iso: string): boolean {
  if (frequencyType === "daily") return true;
  const wd = qatarWeekday(iso);
  return customDays.includes(wd);
}

/** Next occurrence at sendTime (Qatar) on an allowed day, strictly after `after`. */
export function computeNextScheduledAt(
  config: {
    enabled: boolean;
    frequencyType: "daily" | "custom";
    customDays: number[];
    sendTime: string;
  },
  after = new Date(),
): Date | null {
  if (!config.enabled) return null;
  const { hour, minute } = parseSendTime(config.sendTime);
  const startIso = ymdInQatar(after);

  for (let offset = 0; offset < 14; offset++) {
    const iso = addDaysIso(startIso, offset);
    if (!shouldSendToday(config.frequencyType, config.customDays, iso)) continue;

    const candidate = new Date(`${iso}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+03:00`);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

function rowToDto(row: typeof schema.clientReportConfigs.$inferSelect) {
  return {
    id: row.id,
    extClientId: row.extClientId,
    clientName: row.clientName,
    enabled: row.enabled,
    recipientEmail: row.recipientEmail,
    recipientPhone: row.recipientPhone ?? null,
    dataSections: row.dataSections ?? [],
    frequencyType: row.frequencyType,
    customDays: row.customDays ?? [],
    sendTime: row.sendTime,
    asOfMode: row.asOfMode as "latest" | "previous_trading_day",
    rangeDays: row.rangeDays,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function validateSections(sections: ClientReportSection[] | undefined, allowEmpty = false): ClientReportSection[] {
  const list = sections ?? [];
  if (!list.length && allowEmpty) return [];
  if (!list.length) throw Object.assign(new Error("Select at least one report section"), { status: 400 });
  const invalid = list.filter((s) => !ALL_REPORT_SECTIONS.includes(s));
  if (invalid.length) throw Object.assign(new Error(`Invalid sections: ${invalid.join(", ")}`), { status: 400 });
  return list;
}

function validateSendTime(sendTime: string | undefined): string {
  const v = sendTime ?? "09:00";
  if (!/^\d{2}:\d{2}$/.test(v)) throw Object.assign(new Error("sendTime must be HH:mm"), { status: 400 });
  const { hour, minute } = parseSendTime(v);
  if (hour > 23 || minute > 59) throw Object.assign(new Error("Invalid sendTime"), { status: 400 });
  return v;
}

export async function ensureGlobalClientReportConfig(): Promise<typeof schema.clientReportGlobalSettings.$inferSelect> {
  const [row] = await db.select().from(schema.clientReportGlobalSettings)
    .where(eq(schema.clientReportGlobalSettings.id, 1)).limit(1);
  if (row) return row;
  const [inserted] = await db.insert(schema.clientReportGlobalSettings).values({
    id: 1,
    schedulingEnabled: DEFAULT_GLOBAL_CLIENT_REPORT.schedulingEnabled,
    dataSections: DEFAULT_GLOBAL_CLIENT_REPORT.dataSections,
    frequencyType: DEFAULT_GLOBAL_CLIENT_REPORT.frequencyType,
    customDays: DEFAULT_GLOBAL_CLIENT_REPORT.customDays,
    sendTime: DEFAULT_GLOBAL_CLIENT_REPORT.sendTime,
    asOfMode: DEFAULT_GLOBAL_CLIENT_REPORT.asOfMode,
    rangeDays: DEFAULT_GLOBAL_CLIENT_REPORT.rangeDays,
  }).returning();
  return inserted;
}

function globalToDto(row: typeof schema.clientReportGlobalSettings.$inferSelect): ClientReportGlobalConfig {
  return {
    schedulingEnabled: row.schedulingEnabled,
    dataSections: row.dataSections?.length ? row.dataSections : DEFAULT_GLOBAL_CLIENT_REPORT.dataSections,
    frequencyType: row.frequencyType,
    customDays: row.customDays?.length ? row.customDays : DEFAULT_GLOBAL_CLIENT_REPORT.customDays,
    sendTime: row.sendTime,
    asOfMode: row.asOfMode as "latest" | "previous_trading_day",
    rangeDays: row.rangeDays,
    deliveryConfig: publicDeliveryConfig(row.deliveryConfig),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export async function getGlobalClientReportConfig(): Promise<ClientReportGlobalConfig> {
  const row = await ensureGlobalClientReportConfig();
  return globalToDto(row);
}

export async function updateGlobalClientReportConfig(
  input: Partial<Omit<ClientReportGlobalConfig, "updatedAt">>,
  userId?: string | null,
) {
  await ensureGlobalClientReportConfig();
  const frequencyType = input.frequencyType ?? "daily";
  const customDays = frequencyType === "custom"
    ? (input.customDays ?? DEFAULT_GLOBAL_CLIENT_REPORT.customDays)
    : [];
  if (frequencyType === "custom" && customDays.length === 0) {
    throw Object.assign(new Error("Select at least one day for custom frequency"), { status: 400 });
  }
  const dataSections = input.dataSections != null
    ? validateSections(input.dataSections)
    : DEFAULT_GLOBAL_CLIENT_REPORT.dataSections;
  const sendTime = input.sendTime != null ? validateSendTime(input.sendTime) : DEFAULT_GLOBAL_CLIENT_REPORT.sendTime;

  const existing = await ensureGlobalClientReportConfig();
  const [row] = await db.update(schema.clientReportGlobalSettings).set({
    schedulingEnabled: input.schedulingEnabled ?? true,
    dataSections,
    frequencyType,
    customDays,
    sendTime,
    asOfMode: input.asOfMode ?? "latest",
    rangeDays: input.rangeDays != null ? Math.max(1, input.rangeDays) : 1,
    ...(input.deliveryConfig != null
      ? { deliveryConfig: mergeDeliveryConfigUpdate(existing.deliveryConfig, input.deliveryConfig) }
      : {}),
    updatedAt: new Date(),
  }).where(eq(schema.clientReportGlobalSettings.id, 1)).returning();

  await syncAllClientNextScheduled(getGlobalFromRow(row));
  await writeAudit({
    action: "update",
    objectType: "client_report_global",
    objectId: null,
    userId: userId ?? null,
    reason: "client_report_global_settings id=1",
  });
  return globalToDto(row);
}

function getGlobalFromRow(row: typeof schema.clientReportGlobalSettings.$inferSelect): ClientReportGlobalConfig {
  return globalToDto(row);
}

export function mergeEffectiveConfig(
  global: ClientReportGlobalConfig,
  client: typeof schema.clientReportConfigs.$inferSelect | null,
  contacts?: { sourceEmail?: string | null; sourcePhone?: string | null },
): EffectiveClientReportConfig {
  const clientSections = client?.dataSections ?? [];
  const usesGlobalSections = clientSections.length === 0;
  return {
    extClientId: client?.extClientId ?? 0,
    clientName: client?.clientName ?? null,
    enabled: client?.enabled ?? false,
    recipientEmail: client?.recipientEmail ?? null,
    recipientPhone: client?.recipientPhone ?? null,
    sourceEmail: contacts?.sourceEmail ?? null,
    sourcePhone: contacts?.sourcePhone ?? null,
    dataSections: usesGlobalSections ? global.dataSections : clientSections,
    frequencyType: global.frequencyType,
    customDays: global.customDays,
    sendTime: global.sendTime,
    asOfMode: global.asOfMode,
    rangeDays: global.rangeDays,
    usesGlobalSections,
  };
}

async function syncAllClientNextScheduled(global: ClientReportGlobalConfig) {
  const rows = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.enabled, true));
  for (const row of rows) {
    const next = global.schedulingEnabled
      ? computeNextScheduledAt({
          enabled: true,
          frequencyType: global.frequencyType,
          customDays: global.customDays,
          sendTime: global.sendTime,
        })
      : null;
    await db.update(schema.clientReportConfigs).set({ nextScheduledAt: next, updatedAt: new Date() })
      .where(eq(schema.clientReportConfigs.id, row.id));
  }
}

export type ClientReportBoardRow = {
  configId: string | null;
  extClientId: number;
  clientName: string;
  enabled: boolean;
  usesGlobalSections: boolean;
  recipientEmail: string | null;
  recipientPhone: string | null;
  sourceEmail: string | null;
  sourcePhone: string | null;
  effectiveEmail: string | null;
  effectivePhone: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  effectiveSections: ClientReportSection[];
  reportSummary: string;
  frequencyLabel: string;
  sendTime: string;
  nextScheduledAt: string | null;
  lastSentAt: string | null;
};

async function loadClientContacts(extClientId: number) {
  if (!isExtSqlConfigured()) return { sourceEmail: null as string | null, sourcePhone: null as string | null };
  try {
    const clients = await listExtClients(todayQatar());
    const match = clients.find((c) => c.clientId === extClientId);
    return {
      sourceEmail: match?.email?.trim() || null,
      sourcePhone: match?.mobile?.trim() || null,
    };
  } catch {
    return { sourceEmail: null, sourcePhone: null };
  }
}

function resolveContacts(
  cfg: typeof schema.clientReportConfigs.$inferSelect | null,
  ext: { email?: string | null; mobile?: string | null },
) {
  const sourceEmail = ext.email?.trim() || null;
  const sourcePhone = ext.mobile?.trim() || null;
  const effectiveEmail = cfg?.recipientEmail?.trim() || sourceEmail || null;
  const effectivePhone = cfg?.recipientPhone?.trim() || sourcePhone || null;
  return {
    sourceEmail,
    sourcePhone,
    effectiveEmail,
    effectivePhone,
    hasEmail: Boolean(effectiveEmail),
    hasPhone: Boolean(effectivePhone),
  };
}

export async function listClientReportBoard(): Promise<{
  global: ClientReportGlobalConfig;
  clients: ClientReportBoardRow[];
  deliveryStatus: DeliveryChannelStatus;
  clientsLoadError?: string | null;
}> {
  const row = await ensureGlobalClientReportConfig();
  const global = globalToDto(row);
  const deliveryStatus = await getDeliveryChannelStatus(row.deliveryConfig);
  const asOf = todayQatar();
  let extClients: Awaited<ReturnType<typeof listExtClients>> = [];
  let clientsLoadError: string | null = null;
  if (!isExtSqlConfigured()) {
    clientsLoadError = "External SQL is not configured — connect MSSQL to list clients";
  } else {
    try {
      extClients = await listExtClients(asOf);
    } catch (err) {
      clientsLoadError = err instanceof Error ? err.message : "Failed to load clients from SQL";
    }
  }
  const configRows = await db.select().from(schema.clientReportConfigs);
  const byClientId = new Map(configRows.map((r) => [r.extClientId, r]));

  const clients: ClientReportBoardRow[] = extClients.map((c) => {
    const cfg = byClientId.get(c.clientId) ?? null;
    const contacts = resolveContacts(cfg, c);
    const effective = mergeEffectiveConfig(global, cfg, contacts);
    const schedulingOn = global.schedulingEnabled && effective.enabled;
    return {
      configId: cfg?.id ?? null,
      extClientId: c.clientId,
      clientName: c.name || String(c.clientId),
      enabled: effective.enabled,
      usesGlobalSections: effective.usesGlobalSections,
      recipientEmail: effective.recipientEmail,
      recipientPhone: effective.recipientPhone,
      sourceEmail: contacts.sourceEmail,
      sourcePhone: contacts.sourcePhone,
      effectiveEmail: contacts.effectiveEmail,
      effectivePhone: contacts.effectivePhone,
      hasEmail: contacts.hasEmail,
      hasPhone: contacts.hasPhone,
      effectiveSections: effective.dataSections,
      reportSummary: formatSectionsSummary(effective.dataSections),
      frequencyLabel: formatFrequencyFrom(global),
      sendTime: global.sendTime,
      nextScheduledAt: schedulingOn
        ? (cfg?.nextScheduledAt?.toISOString()
          ?? computeNextScheduledAt({
            enabled: true,
            frequencyType: global.frequencyType,
            customDays: global.customDays,
            sendTime: global.sendTime,
          })?.toISOString()
          ?? null)
        : null,
      lastSentAt: cfg?.lastSentAt?.toISOString() ?? null,
    };
  });

  clients.sort((a, b) => a.clientName.localeCompare(b.clientName));
  return { global, clients, deliveryStatus, clientsLoadError };
}

async function ensureClientConfigRow(extClientId: number, clientName?: string | null) {
  const [existing] = await db.select().from(schema.clientReportConfigs)
    .where(eq(schema.clientReportConfigs.extClientId, extClientId)).limit(1);
  if (existing) return existing;

  let name = clientName ?? null;
  if (!name) {
    const clients = await listExtClients(todayQatar());
    name = clients.find((c) => c.clientId === extClientId)?.name ?? String(extClientId);
  }

  const global = await getGlobalClientReportConfig();
  const [row] = await db.insert(schema.clientReportConfigs).values({
    extClientId,
    clientName: name,
    enabled: false,
    dataSections: [],
    frequencyType: global.frequencyType,
    customDays: global.customDays,
    sendTime: global.sendTime,
    asOfMode: global.asOfMode,
    rangeDays: global.rangeDays,
  }).returning();
  return row;
}

export async function toggleClientReportByExtId(extClientId: number, enabled: boolean, userId?: string | null) {
  const row = await ensureClientConfigRow(extClientId);
  const global = await getGlobalClientReportConfig();
  const next = enabled && global.schedulingEnabled
    ? computeNextScheduledAt({
        enabled: true,
        frequencyType: global.frequencyType,
        customDays: global.customDays,
        sendTime: global.sendTime,
      })
    : null;

  const [updated] = await db.update(schema.clientReportConfigs).set({
    enabled,
    nextScheduledAt: next,
    updatedBy: userId ?? null,
    updatedAt: new Date(),
  }).where(eq(schema.clientReportConfigs.id, row.id)).returning();

  await writeAudit({
    action: "update",
    objectType: "client_report_config",
    objectId: updated.id,
    userId: userId ?? null,
    newValue: { extClientId, enabled },
  });

  const effective = mergeEffectiveConfig(global, updated);
  return {
    ...rowToDto(updated),
    reportSummary: formatSectionsSummary(effective.dataSections),
    frequencyLabel: formatFrequencyFrom(global),
    effectiveSections: effective.dataSections,
  };
}

export async function listClientReportConfigs() {
  const rows = await db.select().from(schema.clientReportConfigs).orderBy(asc(schema.clientReportConfigs.clientName));
  return rows.map(rowToDto);
}

export async function getClientReportConfig(id: string) {
  const [row] = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).limit(1);
  if (!row) throw Object.assign(new Error("Report configuration not found"), { status: 404 });
  return rowToDto(row);
}

export async function createClientReportConfig(input: ClientReportConfigInput, userId?: string | null) {
  const sections = validateSections(input.dataSections, true);
  const global = await getGlobalClientReportConfig();
  const effectiveSections = sections.length ? sections : global.dataSections;
  if (!effectiveSections.length) {
    throw Object.assign(new Error("Select at least one report section in global or client config"), { status: 400 });
  }

  const [existing] = await db.select().from(schema.clientReportConfigs)
    .where(eq(schema.clientReportConfigs.extClientId, input.extClientId)).limit(1);
  if (existing) throw Object.assign(new Error("This client already has a report configuration"), { status: 409 });

  let clientName = input.clientName ?? null;
  if (!clientName) {
    const clients = await listExtClients(todayQatar());
    const match = clients.find((c) => c.clientId === input.extClientId);
    clientName = match?.name ?? String(input.extClientId);
  }

  const enabled = input.enabled ?? false;
  const [row] = await db.insert(schema.clientReportConfigs).values({
    extClientId: input.extClientId,
    clientName,
    enabled,
    recipientEmail: input.recipientEmail ?? null,
    recipientPhone: input.recipientPhone ?? null,
    dataSections: sections,
    frequencyType: global.frequencyType,
    customDays: global.customDays,
    sendTime: global.sendTime,
    asOfMode: global.asOfMode,
    rangeDays: global.rangeDays,
    createdBy: userId ?? null,
    updatedBy: userId ?? null,
    nextScheduledAt: enabled && global.schedulingEnabled
      ? computeNextScheduledAt({
          enabled: true,
          frequencyType: global.frequencyType,
          customDays: global.customDays,
          sendTime: global.sendTime,
        })
      : null,
  }).returning();

  await writeAudit({
    action: "create",
    objectType: "client_report_config",
    objectId: row.id,
    userId: userId ?? null,
    newValue: { extClientId: input.extClientId },
  });

  return rowToDto(row);
}

export async function updateClientReportConfig(id: string, input: Partial<ClientReportConfigInput>, userId?: string | null) {
  const [current] = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).limit(1);
  if (!current) throw Object.assign(new Error("Report configuration not found"), { status: 404 });

  const enabled = input.enabled ?? current.enabled;
  const dataSections = input.dataSections != null
    ? validateSections(input.dataSections, true)
    : current.dataSections;
  const global = await getGlobalClientReportConfig();
  const merged = mergeEffectiveConfig(global, {
    ...current,
    dataSections,
    enabled,
    recipientEmail: input.recipientEmail !== undefined ? input.recipientEmail : current.recipientEmail,
    recipientPhone: input.recipientPhone !== undefined ? input.recipientPhone : current.recipientPhone,
    clientName: input.clientName ?? current.clientName,
  });

  if (!merged.dataSections.length) {
    throw Object.assign(new Error("Select at least one report section in global or client config"), { status: 400 });
  }

  const [row] = await db.update(schema.clientReportConfigs).set({
    clientName: input.clientName ?? current.clientName,
    enabled,
    recipientEmail: input.recipientEmail !== undefined ? input.recipientEmail : current.recipientEmail,
    recipientPhone: input.recipientPhone !== undefined ? input.recipientPhone : current.recipientPhone,
    dataSections,
    updatedBy: userId ?? null,
    updatedAt: new Date(),
    nextScheduledAt: enabled && global.schedulingEnabled
      ? computeNextScheduledAt({
          enabled: true,
          frequencyType: global.frequencyType,
          customDays: global.customDays,
          sendTime: global.sendTime,
        })
      : null,
  }).where(eq(schema.clientReportConfigs.id, id)).returning();

  await writeAudit({
    action: "update",
    objectType: "client_report_config",
    objectId: id,
    userId: userId ?? null,
  });

  return rowToDto(row);
}

export async function deleteClientReportConfig(id: string, userId?: string | null) {
  const [row] = await db.delete(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).returning();
  if (!row) throw Object.assign(new Error("Report configuration not found"), { status: 404 });
  await writeAudit({
    action: "delete",
    objectType: "client_report_config",
    objectId: id,
    userId: userId ?? null,
    oldValue: { extClientId: row.extClientId },
  });
  return { ok: true };
}

export async function toggleClientReportConfig(id: string, enabled: boolean, userId?: string | null) {
  const [current] = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).limit(1);
  if (!current) throw Object.assign(new Error("Report configuration not found"), { status: 404 });
  return updateClientReportConfig(id, { enabled }, userId);
}

export async function buildClientReport(
  effective: EffectiveClientReportConfig,
): Promise<ClientReportPayload> {
  const asOf = resolveAsOf(effective.asOfMode);
  const { from, to } = resolveRange(asOf, effective.rangeDays);
  const clientId = effective.extClientId;
  const sections: Partial<Record<ClientReportSection, unknown>> = {};
  const printedAt = new Date().toISOString();

  for (const section of effective.dataSections ?? []) {
    switch (section) {
      case "portfolio_statement":
        sections.portfolio_statement = await getPortfolioStatement(clientId, asOf, printedAt);
        break;
      case "account_statement":
        sections.account_statement = await getAccountStatement(clientId, from, to, printedAt);
        break;
      case "realized_summary":
        sections.realized_summary = await getRealizedSummaryStatement(clientId, from, to, printedAt);
        break;
      case "realized_details":
        sections.realized_details = await getRealizedDetailsStatement(clientId, from, to, printedAt);
        break;
      case "balance_snapshot": {
        const snap = await listStoredSnapshots(asOf);
        sections.balance_snapshot = snap.rows.find((r) => r.clientId === clientId) ?? null;
        break;
      }
      case "transactions": {
        const acct = await getAccountStatement(clientId, from, to, printedAt);
        sections.transactions = acct?.lines ?? [];
        break;
      }
      case "performance": {
        const portfolio = await getPortfolioStatement(clientId, asOf, printedAt);
        sections.performance = portfolio ? {
          nav: portfolio.footer?.netAssetValue,
          marketValue: portfolio.grandTotalMarketValue,
          cost: portfolio.grandTotalCost,
          cash: portfolio.footer?.clientNetCashBalance,
          netPl: portfolio.footer?.netProfitLoss,
          asOf,
        } : null;
        break;
      }
      default:
        break;
    }
  }

  const portfolioRef = sections.portfolio_statement as {
    investor?: { email?: string; mobile?: string; displayName?: string };
  } | null | undefined;
  const email = effective.recipientEmail || effective.sourceEmail || portfolioRef?.investor?.email || null;
  const phone = effective.recipientPhone || effective.sourcePhone || portfolioRef?.investor?.mobile || null;

  return {
    title: `Client Report — ${effective.clientName ?? clientId}`,
    generatedAt: printedAt,
    asOf,
    from,
    to,
    client: {
      id: clientId,
      name: effective.clientName ?? portfolioRef?.investor?.displayName ?? String(clientId),
      email,
      phone,
    },
    sections,
    sectionLabels: {
      portfolio_statement: "Portfolio statement",
      account_statement: "Account statement",
      realized_summary: "Realized P&L summary",
      realized_details: "Realized P&L details",
      balance_snapshot: "Balance reconciliation",
      transactions: "Transactions",
      performance: "Performance summary",
    },
  };
}

export async function previewClientReport(id: string) {
  const [config] = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).limit(1);
  if (!config) throw Object.assign(new Error("Report configuration not found"), { status: 404 });
  const global = await getGlobalClientReportConfig();
  const contacts = await loadClientContacts(config.extClientId);
  return buildClientReport(mergeEffectiveConfig(global, config, contacts));
}

export async function previewClientReportByExtId(extClientId: number) {
  const row = await ensureClientConfigRow(extClientId);
  const global = await getGlobalClientReportConfig();
  const contacts = await loadClientContacts(extClientId);
  return buildClientReport(mergeEffectiveConfig(global, row, contacts));
}

async function deliverReport(
  _global: ClientReportGlobalConfig,
  payload: ClientReportPayload,
  userId?: string | null,
): Promise<{ delivered: boolean; note: string; results: import("./client-report-delivery.js").DeliveryChannelResult[] }> {
  const row = await ensureGlobalClientReportConfig();
  const deliveryConfig = normalizeDeliveryConfig(row.deliveryConfig);
  const enabledAny = deliveryConfig.email.enabled
    || deliveryConfig.metaWhatsapp.enabled
    || deliveryConfig.wassenger.enabled;
  if (!enabledAny) {
    return {
      delivered: false,
      note: "No delivery channels enabled — configure Email, Wassenger, or Meta WhatsApp at the top",
      results: [],
    };
  }
  const pdf = await generateClientReportPdf(payload);
  const summary = await deliverClientReport(
    deliveryConfig,
    payload,
    { email: payload.client.email, phone: payload.client.phone },
    userId ?? null,
    { pdf },
  );
  return {
    delivered: summary.anyDelivered,
    note: summary.summary,
    results: summary.results,
  };
}

export async function sendClientReport(
  id: string,
  trigger: "manual" | "scheduled",
  userId?: string | null,
) {
  const [config] = await db.select().from(schema.clientReportConfigs).where(eq(schema.clientReportConfigs.id, id)).limit(1);
  if (!config) throw Object.assign(new Error("Report configuration not found"), { status: 404 });
  if (!config.enabled && trigger === "scheduled") {
    return { status: "skipped", reason: "Configuration disabled" };
  }

  const [logRow] = await db.insert(schema.clientReportSendLog).values({
    configId: id,
    extClientId: config.extClientId,
    triggerType: trigger,
    status: "pending",
    sentBy: userId ?? null,
  }).returning();

  try {
    const global = await getGlobalClientReportConfig();
    const contacts = await loadClientContacts(config.extClientId);
    const effective = mergeEffectiveConfig(global, config, contacts);
    const payload = await buildClientReport(effective);
    const delivery = await deliverReport(global, payload, userId);
    const note = delivery.note;
    const status = delivery.delivered ? "sent" : "failed";

    await db.update(schema.clientReportSendLog).set({
      status,
      errorMessage: delivery.delivered ? null : note,
      payload: { ...payload, deliveryNote: note, deliveryResults: delivery.results },
      sentAt: new Date(),
    }).where(eq(schema.clientReportSendLog.id, logRow.id));

    if (!delivery.delivered) {
      return {
        status: "failed",
        payload,
        deliveryNote: note,
        deliveryResults: delivery.results,
        delivered: false,
        logId: logRow.id,
      };
    }

    const next = config.enabled && global.schedulingEnabled
      ? computeNextScheduledAt({
          enabled: true,
          frequencyType: global.frequencyType,
          customDays: global.customDays,
          sendTime: global.sendTime,
        })
      : null;

    await db.update(schema.clientReportConfigs).set({
      lastSentAt: new Date(),
      nextScheduledAt: next,
      updatedAt: new Date(),
    }).where(eq(schema.clientReportConfigs.id, id));

    await writeAudit({
      action: "export",
      objectType: "client_report_config",
      objectId: id,
      userId: userId ?? null,
      newValue: { extClientId: config.extClientId, trigger, deliveryNote: note },
    });

    return {
      status: "sent",
      payload,
      deliveryNote: note,
      deliveryResults: delivery.results,
      delivered: true,
      logId: logRow.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(schema.clientReportSendLog).set({
      status: "failed",
      errorMessage: message,
      sentAt: new Date(),
    }).where(eq(schema.clientReportSendLog.id, logRow.id));
    throw Object.assign(new Error(message), { status: 500 });
  }
}

export async function sendClientReportByExtId(extClientId: number, userId?: string | null) {
  const row = await ensureClientConfigRow(extClientId);
  return sendClientReport(row.id, "manual", userId);
}

export async function runDueClientReports() {
  const global = await getGlobalClientReportConfig();
  if (!global.schedulingEnabled) return [];

  const now = new Date();
  const due = await db.select().from(schema.clientReportConfigs).where(
    and(
      eq(schema.clientReportConfigs.enabled, true),
      lte(schema.clientReportConfigs.nextScheduledAt, now),
    ),
  );

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const cfg of due) {
    try {
      await sendClientReport(cfg.id, "scheduled", null);
      results.push({ id: cfg.id, ok: true });
    } catch (err) {
      results.push({ id: cfg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export function formatSectionsSummary(sections: ClientReportSection[]): string {
  const labels: Record<ClientReportSection, string> = {
    portfolio_statement: "Portfolio",
    account_statement: "Account",
    realized_summary: "Realized summary",
    realized_details: "Realized details",
    balance_snapshot: "Balance",
    transactions: "Transactions",
    performance: "Performance",
  };
  return (sections ?? []).map((s) => labels[s] ?? s).join(" + ") || "—";
}

export function formatFrequencyFrom(config: {
  frequencyType: "daily" | "custom";
  customDays: number[];
}): string {
  if (config.frequencyType === "daily") return "Daily";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (config.customDays ?? []).map((d) => names[d] ?? String(d)).join(", ") || "Custom";
}

export async function updateClientReportDeliveryConfig(
  input: ClientReportDeliveryConfig | PublicClientReportDeliveryConfig | Record<string, unknown>,
  userId?: string | null,
) {
  const existing = await ensureGlobalClientReportConfig();
  const deliveryConfig = mergeDeliveryConfigUpdate(existing.deliveryConfig, input);
  const [row] = await db.update(schema.clientReportGlobalSettings).set({
    deliveryConfig,
    updatedAt: new Date(),
  }).where(eq(schema.clientReportGlobalSettings.id, 1)).returning();
  await writeAudit({
    action: "update",
    objectType: "client_report_delivery",
    objectId: null,
    userId: userId ?? null,
    newValue: redactDeliveryForAudit(deliveryConfig),
  });
  return {
    global: globalToDto(row),
    deliveryStatus: await getDeliveryChannelStatus(deliveryConfig),
  };
}

export function formatReportSummary(config: typeof schema.clientReportConfigs.$inferSelect): string {
  return formatSectionsSummary(config.dataSections ?? []);
}

export function formatFrequency(config: typeof schema.clientReportConfigs.$inferSelect): string {
  return formatFrequencyFrom(config);
}
