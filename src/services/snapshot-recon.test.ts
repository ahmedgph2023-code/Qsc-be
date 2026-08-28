import { describe, expect, it } from "vitest";
import {
  compareSnapshot,
  ipmsMarketValue,
  moneyMatches,
  snapshotStatus,
  SNAPSHOT_MATCH_TOLERANCE,
} from "./snapshot-recon.js";

describe("snapshot money match", () => {
  it("matches within 0.01 QAR after 2dp round", () => {
    expect(moneyMatches(100.004, 100.006)).toBe(true);
    expect(moneyMatches(100, 100.01)).toBe(true);
    expect(moneyMatches(100, 100.02)).toBe(false);
    expect(moneyMatches(null, 1)).toBeNull();
    expect(SNAPSHOT_MATCH_TOLERANCE).toBe(0.01);
  });
});

describe("ipmsMarketValue", () => {
  it("sums qty × official close and stays null when a close is missing", () => {
    const lots = [
      { ticker: "MHAR", quantity: 1_853_000 },
      { ticker: "GISS", quantity: 1_300_000 },
    ];
    const full = ipmsMarketValue(lots, new Map([
      ["MHAR", { price: 2.508 }],
      ["GISS", { price: 3.328 }],
    ]));
    expect(full.missingCloses).toEqual([]);
    expect(full.marketValue).toBe(1_853_000 * 2.508 + 1_300_000 * 3.328);

    const gap = ipmsMarketValue(lots, new Map([["MHAR", { price: 2.508 }]]));
    expect(gap.marketValue).toBeNull();
    expect(gap.missingCloses).toEqual(["GISS"]);
  });

  it("treats empty lots as market value 0", () => {
    expect(ipmsMarketValue([], new Map())).toEqual({ marketValue: 0, missingCloses: [] });
  });
});

describe("snapshotStatus", () => {
  it("is matched when cash matches and PortfolioValue equals MV or MV+cash", () => {
    const mvAligned = compareSnapshot({
      hasQsc: true,
      qscPortfolioValue: 100,
      qscSystemCash: 10,
      ipmsMarketValue: 100,
      ipmsCash: 10,
      ipmsNavMvPlusCash: 110,
      missingCloses: [],
    });
    expect(mvAligned.status).toBe("matched");
    expect(mvAligned.mvMatch).toBe(true);
    expect(mvAligned.navMatch).toBe(false);
    expect(mvAligned.bankMatch).toBeNull();

    const navAligned = snapshotStatus({
      hasQsc: true,
      qscPortfolioValue: 110,
      qscSystemCash: 10,
      ipmsMarketValue: 100,
      ipmsCash: 10,
      ipmsNavMvPlusCash: 110,
      missingCloses: [],
    });
    expect(navAligned).toBe("matched");
  });

  it("is mismatch when cash differs even if MV matches", () => {
    expect(snapshotStatus({
      hasQsc: true,
      qscPortfolioValue: 100,
      qscSystemCash: 9,
      ipmsMarketValue: 100,
      ipmsCash: 10,
      ipmsNavMvPlusCash: 110,
      missingCloses: [],
    })).toBe("mismatch");
  });

  it("is incomplete when official closes are missing, qsc_missing without SQL row", () => {
    expect(snapshotStatus({
      hasQsc: true,
      qscPortfolioValue: 100,
      qscSystemCash: 10,
      ipmsMarketValue: null,
      ipmsCash: 10,
      ipmsNavMvPlusCash: null,
      missingCloses: ["MHAR"],
    })).toBe("incomplete");
    expect(snapshotStatus({
      hasQsc: false,
      qscPortfolioValue: null,
      qscSystemCash: null,
      ipmsMarketValue: 0,
      ipmsCash: 0,
      ipmsNavMvPlusCash: 0,
      missingCloses: [],
    })).toBe("qsc_missing");
  });

  it("is cash_only when there is no equity and cash/PV still line up", () => {
    expect(snapshotStatus({
      hasQsc: true,
      qscPortfolioValue: 0,
      qscSystemCash: 3_332_844.16,
      ipmsMarketValue: 0,
      ipmsCash: 3_332_844.16,
      ipmsNavMvPlusCash: 3_332_844.16,
      missingCloses: [],
    })).toBe("cash_only");
  });
});
