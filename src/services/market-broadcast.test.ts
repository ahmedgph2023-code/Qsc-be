/**
 * Phase 7 / meeting 3 — broadcast parser + status.
 * Live ticks must not write stock_prices except via persistSessionCloses (س-25).
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyBroadcastPayload,
  getBroadcastStatus,
  getLiveLastPriceMap,
  hubUrlCandidates,
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

  it("reads the executed-trade count under any of the feed's names", () => {
    const withTrades = (row: Record<string, unknown>) => ({
      Data: [{ objectName1: "MarketWatch", objectValue1: [{ symbol: "QNBK", lastTradePrice: "16.5", ...row }] }],
    });
    expect(parseBroadcastPayload(withTrades({ executed: "29" })).quotes[0]?.trades).toBe(29);
    expect(parseBroadcastPayload(withTrades({ noOfTrades: "7" })).quotes[0]?.trades).toBe(7);
    expect(parseBroadcastPayload(withTrades({ Trades: "34" })).quotes[0]?.trades).toBe(34);
    expect(parseBroadcastPayload(withTrades({})).quotes[0]?.trades).toBeNull();
  });

  it("tries the LAN hub before the public hub and de-duplicates", () => {
    const local = "http://192.168.41.201/qscapi/hub";
    const publicUrl = "https://test.qatar-securities.com/qscapi/Hub";
    expect(hubUrlCandidates({ BROADCAST_WS_URL: publicUrl, BROADCAST_WS_URL_LOCAL: local }))
      .toEqual([local, publicUrl]);
    expect(hubUrlCandidates({ BROADCAST_WS_URL: publicUrl })).toEqual([publicUrl]);
    expect(hubUrlCandidates({ BROADCAST_WS_URL: publicUrl, BROADCAST_WS_URL_LOCAL: publicUrl })).toEqual([publicUrl]);
    expect(hubUrlCandidates({})).toEqual([]);
  });

  it("reports the SignalR skip-negotiation transport when a hub is configured", () => {
    const publicUrl = "https://test.qatar-securities.com/qscapi/Hub";
    expect(getBroadcastStatus({ BROADCAST_WS_URL: publicUrl }).hubTransport).toBe("signalr_ws_skip_negotiation");
    expect(getBroadcastStatus({ BROADCAST_WS_URL: publicUrl, BROADCAST_HUB_NEGOTIATE: "1" }).hubTransport)
      .toBe("signalr_negotiate");
    expect(getBroadcastStatus({ BROADCAST_WS_URL: "wss://feed.example/ws" }).hubTransport).toBe("websocket");
    expect(getBroadcastStatus({}).hubTransport).toBeNull();
  });

  it("treats either hub URL as configured", () => {
    expect(isBroadcastUrlConfigured({ BROADCAST_WS_URL_LOCAL: "http://192.168.41.201/qscapi/hub" })).toBe(true);
    expect(isBroadcastUrlConfigured({})).toBe(false);
  });

  it("reports idle without URL but does not claim JSON-sample block after meeting 3", () => {
    expect(isBroadcastUrlConfigured({})).toBe(false);
    const status = getBroadcastStatus({});
    expect(status.ingestOfficialCloses).toBe(false);
  });

  it("picks the broadcast envelope out of SignalR invocation arguments", async () => {
    const { bestHubPayload } = await import("./market-broadcast.js");
    // one object argument (meeting sample shape)
    expect(parseBroadcastPayload(bestHubPayload([sample])).quotes).toHaveLength(2);
    // JSON text argument
    expect(parseBroadcastPayload(bestHubPayload([JSON.stringify(sample)])).quotes).toHaveLength(2);
    // several arguments where only one carries the envelope
    expect(parseBroadcastPayload(bestHubPayload(["QE", sample])).quotes).toHaveLength(2);
    // Data array passed straight through
    expect(parseBroadcastPayload(bestHubPayload([sample.Data])).quotes).toHaveLength(2);
  });

  it("marks a fresh Hub feed as trusted for valuation", () => {
    applyBroadcastPayload(sample, "hub");
    const status = getBroadcastStatus({});
    expect(status.feedSource).toBe("hub");
    expect(status.stale).toBe(false);
    expect(status.valuationTrusted).toBe(true);
    expect(getLiveLastPriceMap().get("MHAR")).toBe(2.508);
  });

  it("refuses to value portfolios from the sample feed", () => {
    applyBroadcastPayload(sample, "sample");
    const status = getBroadcastStatus({});
    expect(status.feedSource).toBe("sample");
    expect(status.valuationTrusted).toBe(false);
    expect(status.blockedReason).toBe("UNTRUSTED_FEED");
    expect(getLiveLastPriceMap().size).toBe(0);
  });

  it("treats a feed older than the stale window as disconnected and untrusted", () => {
    applyBroadcastPayload(sample, "hub");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 120_000));
      const status = getBroadcastStatus({ BROADCAST_STALE_SECONDS: "60" });
      expect(status.stale).toBe(true);
      expect(status.feedAgeSeconds).toBeGreaterThan(60);
      expect(status.connected).toBe(false);
      expect(status.blockedReason).toBe("STALE_FEED");
      expect(status.valuationSource).toBe("official_close");
      expect(getLiveLastPriceMap().size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never mixes rows from two feeds on one board", () => {
    applyBroadcastPayload(sample, "hub");
    const hubCount = getBroadcastStatus({}).quoteCount;
    expect(hubCount).toBe(2);
    applyBroadcastPayload({ Data: [{ objectName2: "MarketWatch", objectValue2: [
      { symbol: "QNBK", lastTradePrice: "14.5", closePrice: "14.4" },
    ] }] }, "sample");
    expect(getBroadcastStatus({}).quoteCount).toBe(1);
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

  it("simulateLiveTicks moves the board but poisons valuation so QA prices cannot reach NAV", async () => {
    const { simulateLiveTicks } = await import("./market-broadcast.js");
    applyBroadcastPayload(sample, "hub");
    const before = getLiveLastPriceMap().get("MHAR");
    expect(before).toBeTypeOf("number");
    const { touched } = simulateLiveTicks(5);
    expect(touched.length).toBeGreaterThan(0);
    const status = getBroadcastStatus({});
    expect(status.syntheticTicks).toBe(true);
    expect(status.valuationTrusted).toBe(false);
    expect(getLiveLastPriceMap().size).toBe(0);
  });

  it("refuses to write official closes from an untrusted feed", async () => {
    const { persistSessionCloses } = await import("./market-broadcast.js");
    applyBroadcastPayload(sample, "sample");
    const result = await persistSessionCloses("2026-09-17");
    expect(result.written).toBe(0);
    expect(result.skipped).toBe("FEED_SAMPLE");
  });
});
