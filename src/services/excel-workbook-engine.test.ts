import { describe, expect, it } from "vitest";
import {
  applyHoldingFormulas,
  buildNavDailyPoints,
  indexLevelReturn,
} from "./excel-workbook-engine.js";

describe("indexLevelReturn", () => {
  it("is asOf / start − 1", () => {
    expect(indexLevelReturn(100, 94.1)).toBeCloseTo(-0.059, 6);
    expect(indexLevelReturn(1000, 1100)).toBeCloseTo(0.1, 10);
  });
  it("is null when start is not positive", () => {
    expect(indexLevelReturn(0, 100)).toBeNull();
    expect(indexLevelReturn(-1, 100)).toBeNull();
  });
});

describe("applyHoldingFormulas", () => {
  it("defaults to shares × price and shares × cost", () => {
    const v = applyHoldingFormulas(
      { quantity: 100, avgCost: 10, currentPrice: 12, totalCost: 1000 },
      {},
    );
    expect(v.currentValue).toBe(1200);
    expect(v.totalCost).toBe(1000);
    expect(v.gainLossValue).toBe(200);
  });
  it("uses catalog expressions", () => {
    const v = applyHoldingFormulas(
      { quantity: 100, avgCost: 10, currentPrice: 12, totalCost: 1000 },
      {
        equity_value: "shares * price",
        total_cost: "shares * cost",
        profit_loss: "equity - totalCost",
      },
    );
    expect(v.currentValue).toBe(1200);
    expect(v.totalCost).toBe(1000);
    expect(v.gainLossValue).toBe(200);
  });
});

describe("buildNavDailyPoints", () => {
  it("Sheet2 daily chg = nav − prevNav and % = chg / prevNav", () => {
    const pts = buildNavDailyPoints(
      [
        { date: "2024-07-01", value: 100 },
        { date: "2024-07-02", value: 110 },
        { date: "2024-07-03", value: 105 },
      ],
      () => 50,
      { daily_chg_qar: "nav - prevNav", daily_chg_pct: "(nav - prevNav) / prevNav" },
    );
    expect(pts[0].nav).toBe(150);
    expect(pts[0].chgQar).toBeNull();
    expect(pts[1].nav).toBe(160);
    expect(pts[1].chgQar).toBe(10);
    expect(pts[1].chgPct).toBeCloseTo(6.6667, 3);
    expect(pts[2].nav).toBe(155);
    expect(pts[2].chgQar).toBe(-5);
  });
});
