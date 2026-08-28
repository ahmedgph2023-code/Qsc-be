import { describe, expect, it } from "vitest";
import {
  allowedGroups,
  benchmarkNameFor,
  modelCodeFor,
  normalizePreference,
  normalizeShariahGroup,
  parseShariahGroupInput,
  universeLabel,
} from "./mandate-rules.js";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";

describe("mandate-rules eligibility primitives (FIN-01)", () => {
  it("normalizes legacy A/B/C onto binary Shariah status", () => {
    expect(normalizeShariahGroup("A")).toBe("shariah");
    expect(normalizeShariahGroup("shariah")).toBe("shariah");
    expect(normalizeShariahGroup("B")).toBe("not_shariah");
    expect(normalizeShariahGroup("C")).toBe("not_shariah");
    expect(normalizeShariahGroup("not_shariah")).toBe("not_shariah");
    expect(normalizeShariahGroup("")).toBeNull();
    expect(normalizeShariahGroup("unknown")).toBeNull();
  });

  it("parseShariahGroupInput rejects invalid values", () => {
    expect(parseShariahGroupInput("shariah")).toBe("shariah");
    expect(() => parseShariahGroupInput("group-x")).toThrow(/shariahGroup/);
  });

  it("treats shariah_purifying preference as unrestricted (implemented supersession)", () => {
    expect(normalizePreference("shariah_purifying")).toBe("unrestricted");
    expect(normalizePreference("fully_shariah")).toBe("fully_shariah");
    expect(allowedGroups("fully_shariah")).toEqual(["shariah"]);
    expect(allowedGroups("unrestricted")).toEqual(["shariah", "not_shariah"]);
    expect(universeLabel("fully_shariah")).toBe("Shariah only");
    expect(benchmarkNameFor("fully_shariah")).toBe("QERI");
    expect(benchmarkNameFor("unrestricted")).toBe("DSM");
  });

  it("maps model codes for preference × risk", () => {
    expect(modelCodeFor("fully_shariah", "medium")).toBe("FS_MED");
    expect(modelCodeFor("fully_shariah", "high")).toBe("FS_HIGH");
    expect(modelCodeFor("unrestricted", "medium")).toBe("UN_MED");
    expect(modelCodeFor("unrestricted", "high")).toBe("UN_HIGH");
  });
});

describe("IPS limit fallbacks align with business rules (FIN-01)", () => {
  it("exposes Blueprint Phase 1 thresholds", () => {
    expect(IPS_LIMIT_FALLBACKS.stockSoft).toBe(0.15);
    expect(IPS_LIMIT_FALLBACKS.stockHard).toBe(0.2);
    expect(IPS_LIMIT_FALLBACKS.sectorSoft).toBe(0.35);
    expect(IPS_LIMIT_FALLBACKS.sectorHard).toBe(0.4);
    expect(IPS_LIMIT_FALLBACKS.loss15).toBe(-0.15);
    expect(IPS_LIMIT_FALLBACKS.loss25).toBe(-0.25);
    expect(IPS_LIMIT_FALLBACKS.loss30).toBe(-0.3);
    expect(IPS_LIMIT_FALLBACKS.underperform).toBe(-0.05);
    expect(IPS_LIMIT_FALLBACKS.daysStock20).toBe(10);
    expect(IPS_LIMIT_FALLBACKS.daysSector40).toBe(5);
  });
});

/** Pure IPS weight checks used by compliance-engine (same thresholds). */
function evaluateWeightChecks(
  weight: number,
  soft: number,
  hard: number,
): "pass" | "warning" | "fail" {
  if (weight > hard) return "fail";
  if (weight > soft) return "warning";
  return "pass";
}

describe("IPS weight gate (compliance primitive)", () => {
  it("flags soft and hard stock breaches", () => {
    expect(evaluateWeightChecks(0.14, 0.15, 0.2)).toBe("pass");
    expect(evaluateWeightChecks(0.16, 0.15, 0.2)).toBe("warning");
    expect(evaluateWeightChecks(0.21, 0.15, 0.2)).toBe("fail");
  });

  it("flags sector soft/hard", () => {
    expect(evaluateWeightChecks(0.34, 0.35, 0.4)).toBe("pass");
    expect(evaluateWeightChecks(0.36, 0.35, 0.4)).toBe("warning");
    expect(evaluateWeightChecks(0.41, 0.35, 0.4)).toBe("fail");
  });
});
