import { describe, expect, it } from "vitest";
import { computeNextScheduledAt } from "./client-report-engine.js";

describe("computeNextScheduledAt", () => {
  it("returns null when disabled", () => {
    expect(computeNextScheduledAt({
      enabled: false,
      frequencyType: "daily",
      customDays: [],
      sendTime: "09:00",
    })).toBeNull();
  });

  it("finds next daily slot after reference time", () => {
    const after = new Date("2026-09-02T10:00:00+03:00");
    const next = computeNextScheduledAt({
      enabled: true,
      frequencyType: "daily",
      customDays: [],
      sendTime: "09:00",
    }, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it("respects custom weekdays", () => {
    const after = new Date("2026-09-02T10:00:00+03:00"); // Wed
    const next = computeNextScheduledAt({
      enabled: true,
      frequencyType: "custom",
      customDays: [1], // Monday only
      sendTime: "09:00",
    }, after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(1);
  });
});
