import { describe, expect, it } from "vitest";
import { roundMoney, roundQar2, sumMoney, toMoneyNumber } from "./money.js";

describe("money helpers (FIN-03 interim)", () => {
  it("rounds to scale", () => {
    expect(roundMoney(1.23456, 4)).toBe(1.2346);
    expect(roundQar2(1.235)).toBe(1.24);
  });

  it("parses numeric strings", () => {
    expect(toMoneyNumber("12.5000")).toBe(12.5);
    expect(toMoneyNumber(null)).toBe(0);
  });

  it("sums with intermediate rounding", () => {
    expect(sumMoney(["0.1", "0.2"], 4)).toBe(0.3);
  });
});
