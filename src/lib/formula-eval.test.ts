import { describe, expect, it } from "vitest";
import { evaluateFormula, tryEvaluateFormula } from "./formula-eval.js";

describe("formula-eval — Excel Table1 operators only", () => {
  it("multiplies shares * price", () => {
    expect(evaluateFormula("shares * price", { shares: 9000, price: 14.3 })).toBeCloseTo(128700, 8);
  });

  it("growth is totalEquity / totalCost - 1", () => {
    expect(evaluateFormula("totalEquity / totalCost - 1", { totalEquity: 1021275, totalCost: 985445 }))
      .toBeCloseTo(1021275 / 985445 - 1, 12);
  });

  it("annualized uses (1+R)^(days/365)-1", () => {
    const r = 0.004919184820801226;
    const days = 1224;
    const got = evaluateFormula("((return + 1) ^ (holdingDays / 365)) - 1", { return: r, holdingDays: days });
    expect(got).toBeCloseTo((1 + r) ** (days / 365) - 1, 12);
  });

  it("rejects unknown names", () => {
    expect(() => evaluateFormula("shares * eval", { shares: 1 })).toThrow(/Unknown variable/);
  });

  it("tryEvaluateFormula falls back", () => {
    expect(tryEvaluateFormula("1 / 0", {}, 3)).toBe(3);
  });
});
