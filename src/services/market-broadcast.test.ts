/**
 * Phase 7 / meeting 3 — broadcast parser + status.
 * Live ticks must not write stock_prices except via persistSessionCloses (س-25).
 */
import { describe, expect, it } from "vitest";
import {
  applyBroadcastPayload,
  getBroadcastStatus,
  getLiveLastPriceMap,
  isBroadcastUrlConfigured,
  parseBroadcastPayload,
} from "./market-broadcast.js";

const sample = {
  ClientMethod: "broadcastMessage",
  Data: [{
    objectName1: "ExchangesSummary",
    objectValue1: [{ exchangeID: "QE", exchangeNameE: "Qatar Exchange", currentValue: "9785.09", volume: "1000", turnOver: "50000", symbolsUP: "10", symbolsDown: "5", symbolsUnChange: "42" }],
    objectName2: "MarketWatch",
    objectValue2: [
      { symbol: "MHAR", lastTradePrice: "2.508", closePrice: "2.500", netChange: "0.008", netChangePerc: "0.32", companyE: "AL MAHHAR", totalVolume: "12000", bidPrice: "2.500", offerPrice: "2.510", sectorE: "Banks" },
      { symbol: "NLCS", lastTradePrice: "0.736", closePrice: "0.735", netChange: "0.001", totalVolume: "800" },
    ],
    objectName5: "MarketIndicies",
    objectValue5: [
      { cI_SECTOR: "9999", ciE_DESC: "General Index", cI_CURRENT_INDEX: "9785.09", cI_CHG_INDEX: "0" },
    ],
  }],
};

describe("market broadcast", () => {
  it("parses MarketWatch lastTradePrice from Hub-shaped JSON", () => {
    const parsed = parseBroadcastPayload(sample);
    expect(parsed.quotes).toHaveLength(2);
    expect(parsed.quotes.find((q) => q.symbol === "MHAR")?.lastTradePrice).toBe(2.508);
    expect(parsed.quotes.find((q) => q.symbol === "MHAR")?.totalVolume).toBe(12000);
    expect(parsed.indices[0]?.nameEn).toBe("General Index");
    expect(parsed.exchange?.exchangeId).toBe("QE");
  });

  it("stores last prices in memory for session valuation", () => {
    applyBroadcastPayload(sample);
    const map = getLiveLastPriceMap();
    expect(map.get("MHAR")).toBe(2.508);
    expect(map.get("NLCS")).toBe(0.736);
  });

  it("reports idle without URL but does not claim JSON-sample block after meeting 3", () => {
    expect(isBroadcastUrlConfigured({})).toBe(false);
    const status = getBroadcastStatus({});
    expect(status.ingestOfficialCloses).toBe(false);
  });

  it("maps QSE public mw.php MarketWatch rows (PrevClosing / Trades / Volume / Value)", async () => {
    const { mapQsePublicWatchRow } = await import("./market-broadcast.js");
    const q = mapQsePublicWatchRow({
      Symbol: "ABQK",
      CompanyEN: "AL AHLI BANK",
      CompanyAR: "البنك الأهلي",
      LastPrice: "3.848",
      PrevClosing: "3.855",
      Change: "-0.007",
      PercentChange: "-0.18",
      BidPrice: "3.81",
      OfferPrice: "3.90",
      BidVolume: "2860",
      OfferVolume: "1459",
      Trades: "42",
      Volume: "12000",
      Value: "46176",
      SectorEN: "Banks & Financial Services",
    });
    expect(q?.symbol).toBe("ABQK");
    expect(q?.lastTradePrice).toBe(3.848);
    expect(q?.closePrice).toBe(3.855);
    expect(q?.trades).toBe(42);
    expect(q?.totalVolume).toBe(12000);
    expect(q?.totalValue).toBe(46176);
  });

  it("simulateLiveTicks nudges last prices in memory without claiming DB writes", async () => {
    const { simulateLiveTicks } = await import("./market-broadcast.js");
    applyBroadcastPayload(sample);
    const before = getLiveLastPriceMap().get("MHAR");
    const { touched } = simulateLiveTicks(5);
    expect(touched.length).toBeGreaterThan(0);
    expect(getLiveLastPriceMap().size).toBeGreaterThanOrEqual(2);
    expect(before).toBeTypeOf("number");
  });
});
