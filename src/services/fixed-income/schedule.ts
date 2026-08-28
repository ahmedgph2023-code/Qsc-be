import {
  addMonths, actualDaysBetween, compareDates, monthsPerPeriod, periodsPerYear,
} from "./day-count.js";

export type CouponPeriod = {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  couponPerPar: number;
  actualDays: number;
  dailyAccrualPerPar: number;
};

/**
 * Build coupon schedule from first period start through maturity.
 * For semi-annual: each window is exactly 6 calendar months (month lengths vary),
 * actualDays = real day count in that window, dailyAccrual = couponPerPar / actualDays.
 */
export function buildCouponSchedule(input: {
  issueDate: string;
  maturityDate: string;
  couponRate: number;
  couponFrequency: string;
  facePar?: number;
}): CouponPeriod[] {
  const freq = input.couponFrequency;
  if (freq === "zero" || input.couponRate <= 0) return [];

  const perYear = periodsPerYear(freq);
  const stepMonths = monthsPerPeriod(freq);
  if (!perYear || !stepMonths) return [];

  const facePar = input.facePar ?? 100;
  const couponPerPar = (input.couponRate * facePar) / perYear;

  const periods: CouponPeriod[] = [];
  let periodStart = input.issueDate.slice(0, 10);
  const maturity = input.maturityDate.slice(0, 10);

  // Walk forward by coupon frequency until maturity
  while (compareDates(periodStart, maturity) < 0) {
    let periodEnd = addMonths(periodStart, stepMonths);
    if (compareDates(periodEnd, maturity) > 0) periodEnd = maturity;
    if (compareDates(periodEnd, periodStart) <= 0) break;

    const actualDays = Math.max(1, actualDaysBetween(periodStart, periodEnd));
    // Short final stub: pro-rate coupon by actual days vs full step length
    const fullEnd = addMonths(periodStart, stepMonths);
    const fullDays = Math.max(1, actualDaysBetween(periodStart, fullEnd));
    const periodCoupon = compareDates(periodEnd, fullEnd) === 0
      ? couponPerPar
      : couponPerPar * (actualDays / fullDays);

    periods.push({
      periodStart,
      periodEnd,
      payDate: periodEnd,
      couponPerPar: round10(periodCoupon),
      actualDays,
      dailyAccrualPerPar: round12(periodCoupon / actualDays),
    });

    periodStart = periodEnd;
  }

  return periods;
}

export function findPeriod(periods: CouponPeriod[], asOf: string): CouponPeriod | null {
  const d = asOf.slice(0, 10);
  for (const p of periods) {
    if (compareDates(d, p.periodStart) >= 0 && compareDates(d, p.periodEnd) < 0) return p;
  }
  return null;
}

/** Accrued interest per 100 (or facePar) from period start through asOf (exclusive of asOf end-of-day convention: include asOf). */
export function accruedPerParThrough(periods: CouponPeriod[], asOf: string, includeAsOf = true): number {
  const d = asOf.slice(0, 10);
  const p = findPeriod(periods, d);
  if (!p) {
    // On a pay date boundary after period end, accrued resets to 0
    return 0;
  }
  const daysHeld = actualDaysBetween(p.periodStart, includeAsOf ? addDaysSafe(d, 1) : d);
  const capped = Math.min(Math.max(0, daysHeld), p.actualDays);
  return round10(p.dailyAccrualPerPar * capped);
}

function addDaysSafe(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function round10(n: number) {
  return Math.round(n * 1e10) / 1e10;
}
function round12(n: number) {
  return Math.round(n * 1e12) / 1e12;
}
