import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappConversations, whatsappMessages } from "../db/schema/whatsapp.js";
import { getConfigRow } from "./config.js";
import {
  RATE_CARD_USD,
  USD_TO_QAR,
  categorizeMessage,
  countryCodeFromMarket,
  marketFromWaId,
  rateFor,
} from "./pricing.js";

function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function prevMonthRange(d = new Date()) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 23, 59, 59, 999));
  return { start, end };
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function emptyCategoryBucket() {
  return {
    MARKETING: 0,
    UTILITY: 0,
    AUTHENTICATION: 0,
    SERVICE: 0,
    UNKNOWN: 0,
  };
}

export function estimateMessageCostUsd(input: {
  direction: string;
  status: string;
  messageType?: string | null;
  templateName?: string | null;
  pricingCategory?: string | null;
  billable?: boolean | null;
  waId?: string | null;
}) {
  if (String(input.direction).toLowerCase() !== "outbound") return 0;
  const status = String(input.status || "").toLowerCase();
  const delivered = status === "delivered" || status === "read" || status === "sent";
  if (!delivered) return 0;
  if (input.billable === false) return 0;
  const category = categorizeMessage(input);
  if (category === "SERVICE" || category === "UNKNOWN") return 0;
  const market = marketFromWaId(input.waId);
  return rateFor(market, category).rate;
}

async function buildLocalPeriod(configId: string, start: Date, end: Date) {
  const rows = await db
    .select({
      direction: whatsappMessages.direction,
      status: whatsappMessages.status,
      messageType: whatsappMessages.messageType,
      templateName: whatsappMessages.templateName,
      pricingCategory: whatsappMessages.pricingCategory,
      billable: whatsappMessages.billable,
      createdAt: whatsappMessages.createdAt,
      waId: whatsappConversations.waId,
    })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .where(
      and(
        eq(whatsappConversations.configId, configId),
        gte(whatsappMessages.createdAt, start),
        lte(whatsappMessages.createdAt, end),
      ),
    );

  const byCategory = emptyCategoryBucket();
  const byCountry = new Map<string, { country: string; label: string; count: number; estimatedCostUsd: number }>();
  const daily = new Map<string, { date: string; sent: number; estimatedCostUsd: number }>();
  const templates = new Map<
    string,
    { name: string; category: string; sent: number; delivered: number; estimatedCostUsd: number }
  >();

  let sent = 0;
  let delivered = 0;
  let read = 0;
  let failed = 0;
  let billableDelivered = 0;
  let estimatedCostUsd = 0;

  for (const row of rows) {
    if (String(row.direction).toLowerCase() !== "outbound") continue;
    const status = String(row.status || "").toLowerCase();
    sent += 1;
    if (status === "delivered" || status === "read") delivered += 1;
    if (status === "read") read += 1;
    if (status === "failed") failed += 1;

    const category = categorizeMessage(row);
    byCategory[category] = (byCategory[category] || 0) + 1;

    const cost = estimateMessageCostUsd({
      direction: row.direction,
      status: row.status,
      messageType: row.messageType,
      templateName: row.templateName,
      pricingCategory: row.pricingCategory,
      billable: row.billable,
      waId: row.waId,
    });
    estimatedCostUsd += cost;
    if (cost > 0) billableDelivered += 1;

    const market = marketFromWaId(row.waId);
    const country = countryCodeFromMarket(market);
    const label = (RATE_CARD_USD[market] || RATE_CARD_USD.OTHER).label;
    const countryRow = byCountry.get(country) || { country, label, count: 0, estimatedCostUsd: 0 };
    countryRow.count += 1;
    countryRow.estimatedCostUsd += cost;
    byCountry.set(country, countryRow);

    const date = row.createdAt ? dayKey(new Date(row.createdAt)) : dayKey(start);
    const day = daily.get(date) || { date, sent: 0, estimatedCostUsd: 0 };
    day.sent += 1;
    day.estimatedCostUsd += cost;
    daily.set(date, day);

    if (row.templateName) {
      const key = row.templateName;
      const tpl = templates.get(key) || {
        name: key,
        category,
        sent: 0,
        delivered: 0,
        estimatedCostUsd: 0,
      };
      tpl.sent += 1;
      if (status === "delivered" || status === "read" || status === "sent") tpl.delivered += 1;
      tpl.estimatedCostUsd += cost;
      templates.set(key, tpl);
    }
  }

  const toQar = (usd: number) => Number((usd * USD_TO_QAR).toFixed(2));

  return {
    sent,
    delivered,
    read,
    failed,
    billableDelivered,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    estimatedCostQar: toQar(estimatedCostUsd),
    estimatedCostEgp: toQar(estimatedCostUsd),
    byCategory,
    byCountry: [...byCountry.values()]
      .map((c) => ({
        ...c,
        estimatedCostUsd: Number(c.estimatedCostUsd.toFixed(4)),
        estimatedCostQar: toQar(c.estimatedCostUsd),
        estimatedCostEgp: toQar(c.estimatedCostUsd),
      }))
      .sort((a, b) => b.count - a.count),
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        ...d,
        estimatedCostUsd: Number(d.estimatedCostUsd.toFixed(4)),
        estimatedCostQar: toQar(d.estimatedCostUsd),
        estimatedCostEgp: toQar(d.estimatedCostUsd),
      })),
    templates: [...templates.values()]
      .map((t) => ({
        ...t,
        estimatedCostUsd: Number(t.estimatedCostUsd.toFixed(4)),
        estimatedCostQar: toQar(t.estimatedCostUsd),
        estimatedCostEgp: toQar(t.estimatedCostUsd),
      }))
      .sort((a, b) => b.sent - a.sent),
  };
}

export async function getUsageBilling(configId: string) {
  await getConfigRow(configId);
  const now = new Date();
  const thisStart = startOfMonth(now);
  const thisEnd = endOfMonth(now);
  const prev = prevMonthRange(now);

  const [localThis, localPrev] = await Promise.all([
    buildLocalPeriod(configId, thisStart, thisEnd),
    buildLocalPeriod(configId, prev.start, prev.end),
  ]);

  const prevCost = localPrev.estimatedCostUsd || 0;
  const vsPreviousMonthPct =
    prevCost > 0 ? Number((((localThis.estimatedCostUsd - prevCost) / prevCost) * 100).toFixed(1)) : 0;

  const byCategoryCost: Record<string, number> = {};
  const byCategoryCostQar: Record<string, number> = {};
  for (const [cat, count] of Object.entries(localThis.byCategory)) {
    const sample = rateFor("QATAR", cat).rate * Number(count);
    byCategoryCost[cat] = Number(sample.toFixed(4));
    byCategoryCostQar[cat] = Number((sample * USD_TO_QAR).toFixed(2));
  }

  return {
    summary: {
      sent: localThis.sent,
      delivered: localThis.delivered,
      read: localThis.read,
      failed: localThis.failed,
      billableDelivered: localThis.billableDelivered,
      estimatedCostUsd: localThis.estimatedCostUsd,
      estimatedCostQar: localThis.estimatedCostQar,
      estimatedCostEgp: localThis.estimatedCostQar,
      vsPreviousMonthPct,
      byCategory: localThis.byCategory,
    },
    fx: { usdToQar: USD_TO_QAR, usdToEgp: USD_TO_QAR },
    byCategoryCost,
    byCategoryCostEgp: byCategoryCostQar,
    byCategoryCostQar,
    byCountry: localThis.byCountry,
    daily: localThis.daily,
    rateCardSample: Object.values(RATE_CARD_USD).map((r) => ({
      market: r.market,
      label: r.label,
      marketing: r.marketing,
      utility: r.utility,
      authentication: r.authentication,
      service: r.service,
    })),
    templates: localThis.templates,
    disclaimer:
      "Estimated Meta conversation cost from IPMS outbound records and published rate-card samples. Final Meta invoice may differ.",
  };
}
