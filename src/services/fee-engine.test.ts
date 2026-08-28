import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  buildFeeNavSegments,
  calendarDaysInclusive,
  dayWeightedManagementFeeAmount,
  daysInCalendarMonth,
  monthEnd,
  performanceFeeAmount,
} from "./fee-engine.js";

describe("fee-engine day-weighted management (QSC ops 17 Aug 2026)", () => {
  it("counts inclusive calendar days and month length", () => {
    expect(calendarDaysInclusive("2025-01-01", "2025-01-26")).toBe(26);
    expect(calendarDaysInclusive("2025-01-27", "2025-01-31")).toBe(5);
    expect(daysInCalendarMonth("2025-01")).toBe(31);
    expect(monthEnd("2025-01")).toBe("2025-01-31");
    expect(addCalendarDays("2025-01-27", -1)).toBe("2025-01-26");
  });

  it("splits month on in-kind top-up (Mr Saad / محار style)", () => {
    const segments = buildFeeNavSegments(
      "2025-01-01",
      "2025-01-31",
      ["2025-01-27"],
      (iso) => (iso < "2025-01-27" ? 3_000_000 : 15_130_000),
    );
    expect(segments).toEqual([
      { from: "2025-01-01", to: "2025-01-26", nav: 3_000_000 },
      { from: "2025-01-27", to: "2025-01-31", nav: 15_130_000 },
    ]);

    const { avgNav, amount } = dayWeightedManagementFeeAmount(segments, 1.5, 31);
    // (3e6*26 + 15.13e6*5) / 31
    const expectedAvg = (3_000_000 * 26 + 15_130_000 * 5) / 31;
    expect(avgNav).toBeCloseTo(expectedAvg, 4);
    expect(amount).toBe(Math.round(expectedAvg * 1.5 / 100 / 12 * 100) / 100);

    // Must be less than charging full month-end NAV for the whole month
    const monthEndOnly = Math.round(15_130_000 * 1.5 / 100 / 12 * 100) / 100;
    expect(amount).toBeLessThan(monthEndOnly);
  });

  it("does not apply post-top-up NAV from the first of the month", () => {
    const flat = dayWeightedManagementFeeAmount(
      [{ from: "2025-01-01", to: "2025-01-31", nav: 15_130_000 }],
      2,
      31,
    );
    const prorated = dayWeightedManagementFeeAmount(
      [
        { from: "2025-01-01", to: "2025-01-26", nav: 3_000_000 },
        { from: "2025-01-27", to: "2025-01-31", nav: 15_130_000 },
      ],
      2,
      31,
    );
    expect(prorated.amount).toBeLessThan(flat.amount);
  });
});

describe("fee-engine performance vs HWM", () => {
  it("charges only when NAV exceeds HWM", () => {
    expect(performanceFeeAmount(10_000_000, 12_000_000, 10)).toEqual({
      excess: -2_000_000,
      amount: 0,
      chargeBase: 12_000_000,
    });
    expect(performanceFeeAmount(13_000_000, 12_000_000, 10)).toEqual({
      excess: 1_000_000,
      amount: 100_000,
      chargeBase: 12_000_000,
    });
  });

  it("applies hurdle above HWM when configured", () => {
    // 10% hurdle on 10M HWM → charge only above 11M
    expect(performanceFeeAmount(10_500_000, 10_000_000, 20, 10).amount).toBe(0);
    expect(performanceFeeAmount(12_000_000, 10_000_000, 20, 10)).toMatchObject({
      chargeBase: 11_000_000,
      excess: 1_000_000,
      amount: 200_000,
    });
  });

  it("stays at zero when NAV equals HWM after in-kind transfer raised the mark", () => {
    // 3M start + 5M*2.426 transfer ≈ 15.13M; HWM bumped by same transfer amount
    const navPerf = 15_000_000;
    const hwm = 15_130_000;
    expect(performanceFeeAmount(navPerf, hwm, 20).amount).toBe(0);
  });
});
