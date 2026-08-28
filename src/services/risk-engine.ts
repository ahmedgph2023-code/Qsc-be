import { db, schema } from "../db/connection.js";
import { eq, and, inArray, ne } from "drizzle-orm";
import {
  getMonthlyIndexReturns,
  getMonthlySimpleReturns,
  getPortfolioHoldings,
} from "./calculations.js";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";
import { benchmarkNameFor, normalizePreference } from "./mandate-rules.js";
import {
  lagsBenchmarkBeyondThreshold,
  underperformThresholdPct,
} from "./risk-underperform.js";

async function getIpsLimits() {
  const rows = await db.select().from(schema.ipsLimitConfig);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.key] = Number(r.value);
  return {
    stockSoft: map.stock_soft_weight ?? IPS_LIMIT_FALLBACKS.stockSoft,
    stockHard: map.stock_hard_weight ?? IPS_LIMIT_FALLBACKS.stockHard,
    sectorSoft: map.sector_soft_weight ?? IPS_LIMIT_FALLBACKS.sectorSoft,
    sectorHard: map.sector_hard_weight ?? IPS_LIMIT_FALLBACKS.sectorHard,
    loss15: map.loss_15 ?? IPS_LIMIT_FALLBACKS.loss15,
    loss25: map.loss_25 ?? IPS_LIMIT_FALLBACKS.loss25,
    loss30: map.loss_30 ?? IPS_LIMIT_FALLBACKS.loss30,
    underperform: map.underperform_3m ?? IPS_LIMIT_FALLBACKS.underperform,
    excessCash: map.excess_cash_ratio ?? IPS_LIMIT_FALLBACKS.excessCash,
    daysStock20: map.days_reduce_stock_20 ?? IPS_LIMIT_FALLBACKS.daysStock20,
    daysSector40: map.days_reduce_sector_40 ?? IPS_LIMIT_FALLBACKS.daysSector40,
  };
}

/** Interim IPS clock: QSE weekdays Sun–Thu only. Holidays still TBD (BD-007). */
export function addQseWeekdays(days: number, from = new Date()): string {
  const d = new Date(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0 Sun … 5 Fri 6 Sat
    if (dow !== 5 && dow !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

function addCalendarDays(days: number): string {
  return addQseWeekdays(days);
}

function compoundMonthlyReturns(pcts: number[]): number {
  let growth = 1;
  for (const p of pcts) growth *= 1 + p / 100;
  return (growth - 1) * 100;
}

export { lagsBenchmarkBeyondThreshold, underperformThresholdPct } from "./risk-underperform.js";

async function upsertAlert(params: {
  portfolioId: string;
  alertType: typeof schema.riskAlerts.$inferInsert.alertType;
  severity: "info" | "warning" | "critical";
  stockId?: string | null;
  sector?: string | null;
  metricValue: number;
  threshold: number;
  dueDate?: string | null;
}) {
  const open = await db.select().from(schema.riskAlerts).where(
    and(
      eq(schema.riskAlerts.portfolioId, params.portfolioId),
      eq(schema.riskAlerts.alertType, params.alertType),
      eq(schema.riskAlerts.status, "open"),
      params.stockId ? eq(schema.riskAlerts.stockId, params.stockId) : eq(schema.riskAlerts.status, "open"),
    )
  );

  const match = open.find((a) =>
    (params.stockId ? a.stockId === params.stockId : !a.stockId) &&
    (params.sector ? a.sector === params.sector : !params.sector || a.sector === params.sector)
  );

  if (match) {
    await db.update(schema.riskAlerts).set({
      metricValue: String(params.metricValue),
      threshold: String(params.threshold),
      severity: params.severity,
      dueDate: params.dueDate ?? match.dueDate,
    }).where(eq(schema.riskAlerts.id, match.id));
    return match.id;
  }

  const [row] = await db.insert(schema.riskAlerts).values({
    portfolioId: params.portfolioId,
    alertType: params.alertType,
    severity: params.severity,
    status: "open",
    stockId: params.stockId ?? null,
    sector: params.sector ?? null,
    metricValue: String(params.metricValue),
    threshold: String(params.threshold),
    dueDate: params.dueDate ?? null,
  }).returning();
  return row.id;
}

async function resolveCleared(portfolioId: string, stillOpenKeys: Set<string>) {
  const open = await db.select().from(schema.riskAlerts).where(
    and(eq(schema.riskAlerts.portfolioId, portfolioId), eq(schema.riskAlerts.status, "open"))
  );
  for (const a of open) {
    const key = `${a.alertType}|${a.stockId ?? ""}|${a.sector ?? ""}`;
    if (!stillOpenKeys.has(key)) {
      await db.update(schema.riskAlerts).set({
        status: "resolved",
        resolvedAt: new Date(),
        resolutionNotes: "Auto-resolved: condition cleared",
      }).where(eq(schema.riskAlerts.id, a.id));
    }
  }
}

export async function scanPortfolioRisk(portfolioId: string) {
  const limits = await getIpsLimits();
  const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolios[0]) return { alerts: 0 };
  const portfolio = portfolios[0];
  const holdings = await getPortfolioHoldings(portfolioId);
  const invested = holdings.reduce((s, h) => s + h.currentValue, 0);
  const cash = Number(portfolio.cashBalance ?? 0);
  const nav = invested + cash;
  const openKeys = new Set<string>();

  if (nav <= 0) {
    await resolveCleared(portfolioId, openKeys);
    return { alerts: 0 };
  }

  const stockIds = holdings.map((h) => h.stockId);
  const stocks = stockIds.length
    ? await db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
    : [];
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const sectorWeights: Record<string, number> = {};

  for (const h of holdings) {
    const w = h.currentValue / nav;
    const stock = stockMap.get(h.stockId);
    if (stock) sectorWeights[stock.sector] = (sectorWeights[stock.sector] ?? 0) + w;

    if (w > limits.stockHard) {
      const key = `stock_weight_20|${h.stockId}|`;
      openKeys.add(key);
      await upsertAlert({
        portfolioId, alertType: "stock_weight_20", severity: "critical",
        stockId: h.stockId, metricValue: w, threshold: limits.stockHard,
        dueDate: addCalendarDays(limits.daysStock20),
      });
    } else if (w > limits.stockSoft) {
      const key = `stock_weight_15|${h.stockId}|`;
      openKeys.add(key);
      await upsertAlert({
        portfolioId, alertType: "stock_weight_15", severity: "warning",
        stockId: h.stockId, metricValue: w, threshold: limits.stockSoft,
      });
    }

    const pnlPct = h.totalCost > 0 ? (h.currentValue - h.totalCost) / h.totalCost : 0;
    if (pnlPct <= limits.loss30) {
      openKeys.add(`stock_loss_30|${h.stockId}|`);
      await upsertAlert({
        portfolioId, alertType: "stock_loss_30", severity: "critical",
        stockId: h.stockId, metricValue: pnlPct, threshold: limits.loss30,
        dueDate: addCalendarDays(1),
      });
    } else if (pnlPct <= limits.loss25) {
      openKeys.add(`stock_loss_25|${h.stockId}|`);
      await upsertAlert({
        portfolioId, alertType: "stock_loss_25", severity: "critical",
        stockId: h.stockId, metricValue: pnlPct, threshold: limits.loss25,
        dueDate: addCalendarDays(5),
      });
    } else if (pnlPct <= limits.loss15) {
      openKeys.add(`stock_loss_15|${h.stockId}|`);
      await upsertAlert({
        portfolioId, alertType: "stock_loss_15", severity: "warning",
        stockId: h.stockId, metricValue: pnlPct, threshold: limits.loss15,
        dueDate: addCalendarDays(5),
      });
    }

    if (stock?.isIlliquid) {
      openKeys.add(`liquidity|${h.stockId}|`);
      await upsertAlert({
        portfolioId, alertType: "liquidity", severity: "info",
        stockId: h.stockId, metricValue: 1, threshold: 0,
      });
    }
    if (stock && (stock.regulatoryStatus === "restricted" || stock.regulatoryStatus === "suspended")) {
      openKeys.add(`regulatory|${h.stockId}|`);
      await upsertAlert({
        portfolioId, alertType: "regulatory", severity: "critical",
        stockId: h.stockId, metricValue: 1, threshold: 0,
      });
    }
  }

  for (const [sector, w] of Object.entries(sectorWeights)) {
    if (w > limits.sectorHard) {
      openKeys.add(`sector_weight_40||${sector}`);
      await upsertAlert({
        portfolioId, alertType: "sector_weight_40", severity: "critical",
        sector, metricValue: w, threshold: limits.sectorHard,
        dueDate: addCalendarDays(limits.daysSector40),
      });
    } else if (w > limits.sectorSoft) {
      openKeys.add(`sector_weight_35||${sector}`);
      await upsertAlert({
        portfolioId, alertType: "sector_weight_35", severity: "warning",
        sector, metricValue: w, threshold: limits.sectorSoft,
      });
    }
  }

  const cashRatio = cash / nav;
  if (cashRatio > limits.excessCash) {
    openKeys.add("excess_cash||");
    await upsertAlert({
      portfolioId, alertType: "excess_cash", severity: "warning",
      metricValue: cashRatio, threshold: limits.excessCash,
    });
  }

  try {
    const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
    const [mandate] = portfolio
      ? await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1)
      : [];
    const benchName = mandate
      ? benchmarkNameFor(normalizePreference(mandate.shariahPreference) || "unrestricted")
      : "DSM";
    const indices = await db.select().from(schema.indices);
    const idx = indices.find((i) =>
      i.name === benchName
      || i.name.toUpperCase().includes(benchName)
      || (benchName === "QERI" && /rayan|qeri|islamic/i.test(i.name))
      || (benchName === "DSM" && /general|dsm|qe index|all.?share/i.test(i.name))
    ) || null;
    const monthly = await getMonthlySimpleReturns(portfolioId);
    const last3 = monthly.slice(-3);
    if (idx && last3.length >= 3) {
      const start = last3[0];
      const idxMonthly = await getMonthlyIndexReturns(idx.id, start.year, start.month);
      const matched: number[] = [];
      for (const m of last3) {
        const hit = idxMonthly.find((r) => r.year === m.year && r.month === m.month);
        if (hit) matched.push(hit.returnPct);
      }
      if (matched.length === 3) {
        const portRet = compoundMonthlyReturns(last3.map((m) => m.simpleReturnPct));
        const idxRet = compoundMonthlyReturns(matched);
        const underBy = idxRet - portRet; // percentage points; positive when portfolio lags
        const thresholdPct = underperformThresholdPct(limits.underperform);
        if (lagsBenchmarkBeyondThreshold(portRet, idxRet, limits.underperform)) {
          openKeys.add("underperform_3m||");
          await upsertAlert({
            portfolioId,
            alertType: "underperform_3m",
            severity: "warning",
            metricValue: underBy,
            threshold: thresholdPct,
            dueDate: addQseWeekdays(10),
          });
        }
      }
    }
  } catch (err) {
    console.error("[risk] underperform_3m check failed", err);
  }

  await resolveCleared(portfolioId, openKeys);
  return { alerts: openKeys.size };
}

export async function scanAllPortfoliosRisk() {
  const all = await db.select().from(schema.portfolios).where(ne(schema.portfolios.status, "closed"));
  let total = 0;
  for (const p of all) {
    const r = await scanPortfolioRisk(p.id);
    total += r.alerts;
  }
  return { portfolios: all.length, openSignals: total };
}
