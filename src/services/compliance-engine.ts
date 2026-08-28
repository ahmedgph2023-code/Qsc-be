import { db, schema } from "../db/connection.js";
import { eq, and, inArray, desc } from "drizzle-orm";
import { isStockEligible } from "./mandate-rules.js";
import { getPortfolioHoldings } from "./calculations.js";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";
import { approvedListBuyCheck, loadApprovedListMap } from "./research-engine.js";
import { getSystemFlag } from "./system-config.js";

export type ComplianceCheck = {
  checkCode: string;
  result: "pass" | "fail" | "warning";
  reasonCode?: string;
  message: string;
  details?: Record<string, unknown>;
};

/** Pure mandate gate used by runCompliance (FIN-01). */
export function buildMandateGateChecks(
  mandate: { approvalStatus: string } | null | undefined,
): ComplianceCheck[] {
  if (!mandate) {
    return [{
      checkCode: "MANDATE_CLASSIFICATION",
      result: "fail",
      reasonCode: "MANDATE_MISSING",
      message: "No mandate on file",
    }];
  }
  if (mandate.approvalStatus !== "approved") {
    return [{
      checkCode: "MANDATE_STATUS",
      result: "fail",
      reasonCode: "MANDATE_NOT_APPROVED",
      message: `Mandate status is ${mandate.approvalStatus}; trading blocked`,
    }];
  }
  return [
    { checkCode: "MANDATE_STATUS", result: "pass", message: "Mandate approved" },
    { checkCode: "MANDATE_CLASSIFICATION", result: "pass", message: "Mandate classification present" },
  ];
}

export function stockWeightCheck(
  ticker: string,
  weight: number,
  soft: number,
  hard: number,
): ComplianceCheck | null {
  if (weight > hard) {
    return {
      checkCode: "STOCK_LIMIT",
      result: "fail",
      reasonCode: "STOCK_HARD",
      message: `${ticker} weight ${(weight * 100).toFixed(1)}% exceeds hard limit ${(hard * 100).toFixed(0)}%`,
      details: { ticker, weight },
    };
  }
  if (weight > soft) {
    return {
      checkCode: "STOCK_LIMIT",
      result: "warning",
      reasonCode: "STOCK_SOFT",
      message: `${ticker} weight ${(weight * 100).toFixed(1)}% above soft limit ${(soft * 100).toFixed(0)}%`,
      details: { ticker, weight },
    };
  }
  return null;
}

export function sectorWeightCheck(
  sector: string,
  weight: number,
  soft: number,
  hard: number,
): ComplianceCheck | null {
  if (weight > hard) {
    return {
      checkCode: "SECTOR_LIMIT",
      result: "fail",
      reasonCode: "SECTOR_HARD",
      message: `Sector ${sector} at ${(weight * 100).toFixed(1)}% exceeds hard ${(hard * 100).toFixed(0)}%`,
      details: { sector, weight },
    };
  }
  if (weight > soft) {
    return {
      checkCode: "SECTOR_LIMIT",
      result: "warning",
      reasonCode: "SECTOR_SOFT",
      message: `Sector ${sector} at ${(weight * 100).toFixed(1)}% above soft ${(soft * 100).toFixed(0)}%`,
      details: { sector, weight },
    };
  }
  return null;
}

/**
 * Medium-risk construction: ~65% core / ~35% satellite, satellite 3–5 names, near equal-weight in satellite.
 * High risk = full active → no construction fail from this helper.
 */
export function coreSatelliteChecks(
  riskProfile: string | null | undefined,
  holdings: { weight: number; sleeve?: string | null }[],
): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];
  if (!holdings.length) return checks;
  const risk = String(riskProfile || "").toLowerCase();
  if (risk === "high") {
    checks.push({
      checkCode: "CORE_SATELLITE",
      result: "pass",
      message: "High-risk mandate: full active (core/satellite construction not enforced)",
    });
    return checks;
  }
  if (risk !== "medium") return checks;

  const hasSleeve = holdings.some((h) => h.sleeve === "core" || h.sleeve === "satellite");
  if (!hasSleeve) {
    checks.push({
      checkCode: "CORE_SATELLITE",
      result: "warning",
      reasonCode: "SLEEVES_MISSING",
      message: "Medium-risk mandate: holdings lack core/satellite sleeves — construction not verified",
    });
    return checks;
  }

  const core = holdings.filter((h) => h.sleeve === "core");
  const sat = holdings.filter((h) => h.sleeve === "satellite");
  const coreW = core.reduce((s, h) => s + h.weight, 0);
  const satW = sat.reduce((s, h) => s + h.weight, 0);

  const coreOk = Math.abs(coreW - 0.65) <= 0.02;
  const satOk = Math.abs(satW - 0.35) <= 0.02;
  checks.push({
    checkCode: "CORE_SATELLITE",
    result: coreOk && satOk ? "pass" : "fail",
    reasonCode: coreOk && satOk ? undefined : "CORE_SAT_WEIGHT",
    message: coreOk && satOk
      ? `Core/satellite weights OK (core ${(coreW * 100).toFixed(1)}% / sat ${(satW * 100).toFixed(1)}%)`
      : `Medium risk expects ~65% core / ~35% satellite (got ${(coreW * 100).toFixed(1)}% / ${(satW * 100).toFixed(1)}%)`,
    details: { coreWeight: coreW, satelliteWeight: satW },
  });

  const countOk = sat.length >= 3 && sat.length <= 5;
  checks.push({
    checkCode: "SATELLITE_COUNT",
    result: countOk ? "pass" : "fail",
    reasonCode: countOk ? undefined : "SATELLITE_COUNT",
    message: countOk
      ? `Satellite names: ${sat.length}`
      : `Satellite names: ${sat.length} (need 3–5 for medium risk)`,
    details: { satelliteCount: sat.length },
  });

  if (sat.length >= 2 && satW > 0) {
    const target = satW / sat.length;
    const maxDev = Math.max(...sat.map((h) => Math.abs(h.weight - target)));
    const equalOk = maxDev <= 0.02;
    checks.push({
      checkCode: "SATELLITE_EQUAL_WEIGHT",
      result: equalOk ? "pass" : "warning",
      reasonCode: equalOk ? undefined : "SAT_UNEQUAL",
      message: equalOk
        ? "Satellite sleeve near equal-weight"
        : `Satellite weights uneven (max deviation ${(maxDev * 100).toFixed(1)}pp from equal)`,
      details: { targetPerName: target, maxDeviation: maxDev },
    });
  }

  return checks;
}

/** Approved exceptions convert matching fail → warning. */
export function applyApprovedExceptions(
  checks: ComplianceCheck[],
  approvedCodes: Set<string>,
): ComplianceCheck[] {
  return checks.map((c) => {
    if (c.result === "fail" && approvedCodes.has(c.checkCode)) {
      return {
        ...c,
        result: "warning" as const,
        message: `${c.message} (exception approved)`,
        reasonCode: "EXCEPTION_APPLIED",
      };
    }
    return c;
  });
}

export function isCompliancePassed(checks: ComplianceCheck[]): boolean {
  return !checks.some((c) => c.result === "fail");
}

async function getIpsLimits() {
  const rows = await db.select().from(schema.ipsLimitConfig);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.key] = Number(r.value);
  return {
    stockSoft: map.stock_soft_weight ?? IPS_LIMIT_FALLBACKS.stockSoft,
    stockHard: map.stock_hard_weight ?? IPS_LIMIT_FALLBACKS.stockHard,
    sectorSoft: map.sector_soft_weight ?? IPS_LIMIT_FALLBACKS.sectorSoft,
    sectorHard: map.sector_hard_weight ?? IPS_LIMIT_FALLBACKS.sectorHard,
    excessCash: map.excess_cash_ratio ?? IPS_LIMIT_FALLBACKS.excessCash,
  };
}

export async function runCompliance(params: {
  portfolioId: string;
  targetWeights?: { stockId: string; weight: number; sleeve?: string | null }[];
  timing?: "before_proposal" | "before_trade" | "after_trade";
  rebalanceId?: string;
  persist?: boolean;
}): Promise<{ checks: ComplianceCheck[]; passed: boolean }> {
  const timing = params.timing ?? "before_proposal";
  const checks: ComplianceCheck[] = [];
  const limits = await getIpsLimits();

  const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, params.portfolioId)).limit(1);
  if (!portfolios[0]) {
    return { checks: [{ checkCode: "PORTFOLIO", result: "fail", message: "Portfolio not found" }], passed: false };
  }
  const portfolio = portfolios[0];
  const mandates = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1);
  const mandate = mandates[0];

  checks.push(...buildMandateGateChecks(mandate));

  const holdings = await getPortfolioHoldings(params.portfolioId);
  const invested = holdings.reduce((s, h) => s + h.currentValue, 0);
  const cash = Number(portfolio.cashBalance ?? 0);
  const nav = invested + cash;

  const weightByStock = new Map<string, number>();
  if (params.targetWeights?.length) {
    for (const t of params.targetWeights) weightByStock.set(t.stockId, t.weight);
  } else {
    for (const h of holdings) {
      weightByStock.set(h.stockId, nav > 0 ? h.currentValue / nav : 0);
    }
  }

  const stockIds = [...weightByStock.keys()];
  const stockRows = stockIds.length
    ? await db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
    : [];
  const stockMap = new Map(stockRows.map((s) => [s.id, s]));
  const approvedMap = await loadApprovedListMap(stockIds);
  const enforceApprovedList = await getSystemFlag("approved_list_enforce", true);

  const sectorWeights: Record<string, number> = {};
  let netBuyEstimate = 0;

  for (const [stockId, weight] of weightByStock) {
    const stock = stockMap.get(stockId);
    if (!stock) {
      checks.push({ checkCode: "STOCK_LIMIT", result: "fail", message: `Unknown stock ${stockId}` });
      continue;
    }

    // Equity concentration / Shariah sleeve checks apply to equities only
    if (stock.instrumentType && stock.instrumentType !== "equity") {
      continue;
    }

    if (mandate) {
      const elig = await isStockEligible({
        shariahPreference: mandate.shariahPreference,
        stockId,
        mandateId: mandate.id,
      });
      if (!elig.allowed) {
        checks.push({
          checkCode: elig.reasons.includes("REGULATORY") ? "REGULATORY" : elig.reasons.some((r) => r.startsWith("RESTRICTION")) ? "RESTRICTION" : "SHARIAH_UNIVERSE",
          result: "fail",
          reasonCode: elig.reasons[0],
          message: `${stock.ticker} not eligible: ${elig.reasons.join(", ")}`,
          details: { ticker: stock.ticker, reasons: elig.reasons },
        });
      } else if (elig.reasons.includes("ILLIQUID_WARNING")) {
        checks.push({
          checkCode: "LIQUIDITY",
          result: "warning",
          reasonCode: "ILLIQUID",
          message: `${stock.ticker} is illiquid (ADTV below policy)`,
        });
      }

      if (weight > 0) {
        const current = holdings.find((h) => h.stockId === stockId);
        const currentW = nav > 0 && current ? current.currentValue / nav : 0;
        if (weight > currentW) {
          netBuyEstimate += (weight - currentW) * nav;
          if (enforceApprovedList) {
            const al = approvedListBuyCheck(approvedMap.get(stockId) ?? null);
            checks.push({
              checkCode: "APPROVED_LIST",
              result: al.result,
              reasonCode: al.reasonCode,
              message: `${stock.ticker}: ${al.message}`,
              details: { ticker: stock.ticker, status: approvedMap.get(stockId) ?? "watchlist" },
            });
          }
        }
      }
    }

    if (weight > limits.stockHard || weight > limits.stockSoft) {
      const stockChk = stockWeightCheck(stock.ticker, weight, limits.stockSoft, limits.stockHard);
      if (stockChk) checks.push(stockChk);
    }

    sectorWeights[stock.sector] = (sectorWeights[stock.sector] ?? 0) + weight;
  }

  for (const [sector, w] of Object.entries(sectorWeights)) {
    const sectorChk = sectorWeightCheck(sector, w, limits.sectorSoft, limits.sectorHard);
    if (sectorChk) checks.push(sectorChk);
  }

  if (params.targetWeights?.length) {
    checks.push(...coreSatelliteChecks(
      mandate?.riskProfile,
      params.targetWeights.map((t) => ({ weight: t.weight, sleeve: t.sleeve })),
    ));
  }

  if (netBuyEstimate > cash + 1) {
    checks.push({
      checkCode: "CASH_CHECK",
      result: "fail",
      reasonCode: "INSUFFICIENT_CASH",
      message: `Estimated buys ${netBuyEstimate.toFixed(0)} exceed cash ${cash.toFixed(0)}`,
      details: { netBuyEstimate, cash },
    });
  } else {
    checks.push({ checkCode: "CASH_CHECK", result: "pass", message: "Cash sufficient for proposed buys" });
  }

  const cashRatio = nav > 0 ? cash / nav : 0;
  if (cashRatio > limits.excessCash) {
    checks.push({
      checkCode: "EXCESS_CASH",
      result: "warning",
      reasonCode: "EXCESS_CASH",
      message: `Cash ${(cashRatio * 100).toFixed(1)}% of NAV exceeds policy ${(limits.excessCash * 100).toFixed(1)}%`,
      details: { cashRatio, threshold: limits.excessCash, cash, nav },
    });
  }

  // Approved exceptions can convert fail→warning for matching check codes
  const exceptions = await db.select().from(schema.complianceExceptions).where(
    and(eq(schema.complianceExceptions.portfolioId, params.portfolioId), eq(schema.complianceExceptions.status, "approved"))
  );
  const approvedCodes = new Set(exceptions.map((e) => e.checkCode));
  const withExceptions = applyApprovedExceptions(checks, approvedCodes);
  checks.length = 0;
  checks.push(...withExceptions);

  if (!checks.some((c) => c.checkCode === "SHARIAH_UNIVERSE" && c.result === "fail") && mandate) {
    if (!checks.some((c) => c.checkCode === "SHARIAH_UNIVERSE")) {
      checks.push({ checkCode: "SHARIAH_UNIVERSE", result: "pass", message: "Universe eligibility ok" });
    }
  }

  const passed = isCompliancePassed(checks);

  if (params.persist !== false) {
    for (const c of checks) {
      await db.insert(schema.complianceResults).values({
        portfolioId: params.portfolioId,
        rebalanceId: params.rebalanceId ?? null,
        checkCode: c.checkCode,
        timing,
        result: c.result,
        reasonCode: c.reasonCode ?? null,
        message: c.message,
        details: c.details ?? null,
      });
    }
  }

  return { checks, passed };
}

export async function listRecentCompliance(portfolioId?: string, limit = 100) {
  if (portfolioId) {
    return db.select().from(schema.complianceResults)
      .where(eq(schema.complianceResults.portfolioId, portfolioId))
      .orderBy(desc(schema.complianceResults.createdAt))
      .limit(limit);
  }
  return db.select().from(schema.complianceResults).orderBy(desc(schema.complianceResults.createdAt)).limit(limit);
}
