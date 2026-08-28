import { buildCouponSchedule } from "./schedule.js";
import { generateDailyBookPnl } from "./accrual.js";
import { actualDaysBetween } from "./day-count.js";

/** Quick console proof for semi-annual ACT_PERIOD daily split. */
function demo() {
  const issueDate = "2024-01-15";
  const maturityDate = "2026-01-15";
  const periods = buildCouponSchedule({
    issueDate,
    maturityDate,
    couponRate: 0.05,
    couponFrequency: "semi_annual",
    facePar: 100,
  });

  console.log("Semi-annual 5% on par 100 — coupon periods:");
  for (const p of periods) {
    const check = actualDaysBetween(p.periodStart, p.periodEnd);
    const daily = 2.5 / check;
    console.log(
      `  ${p.periodStart} → ${p.periodEnd}: actualDays=${p.actualDays} (check=${check}), ` +
      `couponPerPar=${p.couponPerPar}, dailyAccrual=${p.dailyAccrualPerPar.toFixed(10)} (expect ${daily.toFixed(10)})`,
    );
  }

  const rows = generateDailyBookPnl({
    faceAmount: 1_000_000,
    facePar: 100,
    couponRate: 0.05,
    couponFrequency: "semi_annual",
    issueDate,
    maturityDate,
    settlementDate: "2024-01-15",
    purchaseDirty: 100,
    purchaseAccruedPerPar: 0,
    endDate: "2024-01-20",
    periods,
  });

  console.log("\nFirst days book P&L for 1,000,000 face (10,000 units):");
  for (const r of rows) {
    console.log(
      `  ${r.asOfDate}: periodDays=${r.periodActualDays} couponAccrual=${r.couponAccrual.toFixed(4)} ` +
      `amort=${r.amortization.toFixed(4)} bookPnl=${r.bookPnl.toFixed(4)}`,
    );
  }

  // Prove sum of daily accruals in first period equals period coupon for the lot
  const p0 = periods[0];
  const firstPeriodRows = generateDailyBookPnl({
    faceAmount: 1_000_000,
    facePar: 100,
    couponRate: 0.05,
    couponFrequency: "semi_annual",
    issueDate,
    maturityDate,
    settlementDate: p0.periodStart,
    purchaseDirty: 100,
    purchaseAccruedPerPar: 0,
    endDate: p0.periodEnd,
    periods,
  }).filter((r) => r.asOfDate < p0.periodEnd);

  const sumCoupon = firstPeriodRows.reduce((s, r) => s + r.couponAccrual, 0);
  const expected = p0.couponPerPar * (1_000_000 / 100);
  console.log(`\nSum of daily coupon in period 1: ${sumCoupon.toFixed(6)} (expect ${expected.toFixed(6)})`);
}

demo();
