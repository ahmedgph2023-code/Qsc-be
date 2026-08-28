import { describe, expect, it } from "vitest";
import {
  applyApprovedExceptions,
  buildMandateGateChecks,
  coreSatelliteChecks,
  isCompliancePassed,
  sectorWeightCheck,
  stockWeightCheck,
} from "./compliance-engine.js";
import { IPS_LIMIT_FALLBACKS } from "./ips-limit-fallbacks.js";

describe("compliance-engine pure gates (FIN-01b)", () => {
  it("fails when mandate missing or not approved", () => {
    expect(buildMandateGateChecks(null)[0].reasonCode).toBe("MANDATE_MISSING");
    expect(buildMandateGateChecks({ approvalStatus: "draft" })[0].reasonCode).toBe("MANDATE_NOT_APPROVED");
    expect(buildMandateGateChecks({ approvalStatus: "pending" })[0].result).toBe("fail");
  });

  it("passes when mandate approved", () => {
    const checks = buildMandateGateChecks({ approvalStatus: "approved" });
    expect(checks.every((c) => c.result === "pass")).toBe(true);
    expect(isCompliancePassed(checks)).toBe(true);
  });

  it("emits STOCK_SOFT / STOCK_HARD at IPS fallbacks", () => {
    const soft = stockWeightCheck("QNBK", 0.16, IPS_LIMIT_FALLBACKS.stockSoft, IPS_LIMIT_FALLBACKS.stockHard);
    const hard = stockWeightCheck("QNBK", 0.21, IPS_LIMIT_FALLBACKS.stockSoft, IPS_LIMIT_FALLBACKS.stockHard);
    const ok = stockWeightCheck("QNBK", 0.10, IPS_LIMIT_FALLBACKS.stockSoft, IPS_LIMIT_FALLBACKS.stockHard);
    expect(soft?.reasonCode).toBe("STOCK_SOFT");
    expect(hard?.reasonCode).toBe("STOCK_HARD");
    expect(ok).toBeNull();
  });

  it("emits SECTOR_SOFT / SECTOR_HARD at IPS fallbacks", () => {
    const soft = sectorWeightCheck("Banks", 0.36, IPS_LIMIT_FALLBACKS.sectorSoft, IPS_LIMIT_FALLBACKS.sectorHard);
    const hard = sectorWeightCheck("Banks", 0.41, IPS_LIMIT_FALLBACKS.sectorSoft, IPS_LIMIT_FALLBACKS.sectorHard);
    expect(soft?.reasonCode).toBe("SECTOR_SOFT");
    expect(hard?.reasonCode).toBe("SECTOR_HARD");
  });

  it("enforces medium-risk core/satellite construction", () => {
    const ok = coreSatelliteChecks("medium", [
      { weight: 0.65, sleeve: "core" },
      { weight: 0.1167, sleeve: "satellite" },
      { weight: 0.1167, sleeve: "satellite" },
      { weight: 0.1166, sleeve: "satellite" },
    ]);
    expect(ok.find((c) => c.checkCode === "CORE_SATELLITE")?.result).toBe("pass");
    expect(ok.find((c) => c.checkCode === "SATELLITE_COUNT")?.result).toBe("pass");

    const bad = coreSatelliteChecks("medium", [
      { weight: 0.90, sleeve: "core" },
      { weight: 0.10, sleeve: "satellite" },
    ]);
    expect(bad.find((c) => c.checkCode === "CORE_SATELLITE")?.result).toBe("fail");
    expect(bad.find((c) => c.checkCode === "SATELLITE_COUNT")?.result).toBe("fail");
  });

  it("skips construction fail for high risk", () => {
    const checks = coreSatelliteChecks("high", [{ weight: 1, sleeve: "core" }]);
    expect(checks[0].result).toBe("pass");
  });

  it("approved exceptions convert fail to warning", () => {
    const checks = applyApprovedExceptions(
      [{ checkCode: "STOCK_LIMIT", result: "fail", message: "too high" }],
      new Set(["STOCK_LIMIT"]),
    );
    expect(checks[0].result).toBe("warning");
    expect(checks[0].reasonCode).toBe("EXCEPTION_APPLIED");
    expect(isCompliancePassed(checks)).toBe(true);
  });
});
