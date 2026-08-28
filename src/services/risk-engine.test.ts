import { describe, expect, it } from "vitest";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";
import {
  lagsBenchmarkBeyondThreshold,
  underperformThresholdPct,
} from "./risk-underperform.js";

describe("underperform vs benchmark (IPS 5% lag)", () => {
  it("treats stored ratio -0.05 as 5 percentage points", () => {
    expect(underperformThresholdPct(IPS_LIMIT_FALLBACKS.underperform)).toBe(5);
    expect(underperformThresholdPct(-0.05)).toBe(5);
    expect(underperformThresholdPct(0.05)).toBe(5);
    expect(underperformThresholdPct(5)).toBe(5);
    expect(underperformThresholdPct(-5)).toBe(5);
  });

  it("does not alert on a tiny lag (old bug: any lag > -0.05 fired)", () => {
    expect(lagsBenchmarkBeyondThreshold(10, 10.01, -0.05)).toBe(false);
    expect(lagsBenchmarkBeyondThreshold(10, 10, -0.05)).toBe(false);
    expect(lagsBenchmarkBeyondThreshold(10.04, 10, -0.05)).toBe(false);
  });

  it("alerts only when lag exceeds 5 percentage points", () => {
    expect(lagsBenchmarkBeyondThreshold(10, 15.1, -0.05)).toBe(true);
    expect(lagsBenchmarkBeyondThreshold(10, 15, -0.05)).toBe(false);
    expect(lagsBenchmarkBeyondThreshold(10, 14.9, -0.05)).toBe(false);
  });
});
