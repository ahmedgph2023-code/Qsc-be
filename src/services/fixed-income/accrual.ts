import { actualDaysBetween, compareDates, eachDateInclusive, minDate } from "./day-count.js";
import { accruedPerParThrough, buildCouponSchedule, findPeriod, type CouponPeriod } from "./schedule.js";

export type DailyBookRow = {
  asOfDate: string;
  periodActualDays: number | null;
  couponAccrual: number;
  amortization: number;
  bookPnl: number;
  bookValue: number;
  accruedInterest: number;
  couponCash: number;
};

/**
 * Generate daily book P&L from settlement through endDate (inclusive).
 *
 * Semi-annual (and other coupon) accuracy:
 *   periodCoupon = face * rate / periodsPerYear
 *   actualDays   = calendar days in that exact coupon window (months 28–31 handled)
 *   dailyCoupon  = periodCoupon / actualDays
 *
 * Amortization of premium/discount is straight-line over remaining calendar days to maturity.
 */
export function generateDailyBookPnl(input: {
  faceAmount: number;
  facePar: number;
  couponRate: number;
  couponFrequency: string;
  issueDate: string;
  maturityDate: string;
  settlementDate: string;
  purchaseDirty: number;
  purchaseAccruedPerPar: number;
  endDate: string;
  periods?: CouponPeriod[];
}): DailyBookRow[] {
  const {
    faceAmount, facePar, couponRate, couponFrequency,
    issueDate, maturityDate, settlementDate, purchaseDirty, purchaseAccruedPerPar, endDate,
  } = input;

  const periods = input.periods ?? buildCouponSchedule({
    issueDate, maturityDate, couponRate, couponFrequency, facePar,
  });

  const units = faceAmount / facePar;
  const purchaseDirtyCash = units * purchaseDirty;
  // Clean-ish book start: dirty paid minus accrued bought
  const purchaseAccruedCash = units * purchaseAccruedPerPar;
  let bookValue = purchaseDirtyCash;
  const premium = purchaseDirtyCash - faceAmount - purchaseAccruedCash;

  const lastDay = minDate(endDate, maturityDate);
  if (compareDates(settlementDate, lastDay) > 0) return [];

  const remainingDaysAtBuy = Math.max(1, actualDaysBetween(settlementDate, maturityDate));
  // Amortize premium over remaining days to maturity (calendar-accurate)
  const dailyAmort = premium / remainingDaysAtBuy;

  const rows: DailyBookRow[] = [];
  let prevAccrued = purchaseAccruedCash;

  for (const asOf of eachDateInclusive(settlementDate, lastDay)) {
    const period = findPeriod(periods, asOf);
    const periodActualDays = period?.actualDays ?? null;

    // Daily coupon for this lot = dailyAccrualPerPar * units
    let couponAccrual = 0;
    if (period && couponFrequency !== "zero") {
      couponAccrual = period.dailyAccrualPerPar * units;
    }

    // On pay date (= periodEnd of previous period), cash coupon is paid and accrued resets
    let couponCash = 0;
    const paying = periods.find((p) => p.payDate === asOf);
    if (paying && compareDates(asOf, settlementDate) > 0) {
      couponCash = paying.couponPerPar * units;
    }

    const amortization = compareDates(asOf, maturityDate) < 0 ? dailyAmort : 0;
    const bookPnl = couponAccrual + amortization;

    // Accrued inventory after today's accrual (before cash reset on pay date)
    let accruedInterest = accruedPerParThrough(periods, asOf, true) * units;
    if (paying && compareDates(asOf, settlementDate) >= 0) {
      // After payment on pay date, accrued for next period starts at 0 for EOD view
      accruedInterest = 0;
    }

    bookValue = bookValue + bookPnl - couponCash;

    // On maturity, pull book to face (final amort residual)
    if (asOf === maturityDate.slice(0, 10)) {
      const residual = faceAmount - bookValue;
      rows.push({
        asOfDate: asOf,
        periodActualDays,
        couponAccrual: round8(couponAccrual),
        amortization: round8(amortization + residual),
        bookPnl: round8(bookPnl + residual),
        bookValue: round8(faceAmount),
        accruedInterest: 0,
        couponCash: round8(couponCash),
      });
      bookValue = faceAmount;
      prevAccrued = 0;
      continue;
    }

    rows.push({
      asOfDate: asOf,
      periodActualDays,
      couponAccrual: round8(couponAccrual),
      amortization: round8(amortization),
      bookPnl: round8(bookPnl),
      bookValue: round8(bookValue),
      accruedInterest: round8(accruedInterest),
      couponCash: round8(couponCash),
    });
    prevAccrued = accruedInterest;
  }

  return rows;
}

function round8(n: number) {
  return Math.round(n * 1e8) / 1e8;
}
