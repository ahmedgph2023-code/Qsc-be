import { describe, expect, it } from "vitest";
import { applyReplayEvents } from "./holdings-replay.js";
import {
  buildExtHoldings,
  cashBalance,
  eventsFromShares,
  investorDisplayName,
  localizedInvestorName,
  realizedFromEvents,
  shareRowToEvent,
  unitPriceFromShare,
  type ExtCashRow,
  type ExtShareRow,
} from "./ext-sql-portfolio.js";

function share(partial: Partial<ExtShareRow> & Pick<ExtShareRow, "id" | "tickerId" | "invDate" | "buySellFlag" | "qty">): ExtShareRow {
  return {
    companyName: "Test Co",
    invType: "OI",
    nin: "37808",
    clientId: 2041929,
    avgPrice: 0,
    total: 0,
    net: 0,
    totalComm: 0,
    invNo: 1,
    compId: null,
    officeComm: 0,
    marketComm: 0,
    originalPrice: 0,
    ...partial,
  };
}

function cash(partial: Partial<ExtCashRow> & Pick<ExtCashRow, "id" | "postDate">): ExtCashRow {
  return {
    docCode: "JV",
    docNo: 1,
    serNo: 1,
    nin: "37808",
    mainObjCode: "1800101035339",
    objCode: 2041929,
    dbAmt: 0,
    crAmt: 0,
    remarks: null,
    eRemarks: null,
    docDate: partial.postDate,
    docAmt: 0,
    status: "P",
    invoiceNo: null,
    invoiceType: null,
    ...partial,
  };
}

describe("ext-sql-portfolio — SQL blotter mapping", () => {
  it("maps B/S from live BuySellFlag values", () => {
    const buy = shareRowToEvent(share({ id: 1, tickerId: "MHAR", invDate: "2024-07-02", buySellFlag: "B", qty: 1000, net: 1530 }));
    const sell = shareRowToEvent(share({ id: 2, tickerId: "MHAR", invDate: "2024-07-03", buySellFlag: "S", qty: 100, net: 200 }));
    expect(buy).toMatchObject({ kind: "tx", type: "BUY", quantity: 1000, price: 1.53 });
    expect(sell).toMatchObject({ kind: "tx", type: "SELL", quantity: 100, price: 2 });
  });

  it("uses Net ÷ Qty as unit price when Net is present (matches cash proceeds)", () => {
    expect(unitPriceFromShare({ qty: 128282, net: 418328.56, total: 419482.14, avgPrice: 3.261 })).toBeCloseTo(418328.56 / 128282, 10);
  });

  it("treats InvType SP (zero value, qty only) as a costless quantity add", () => {
    const ev = shareRowToEvent(share({
      id: 9,
      tickerId: "BLDN",
      invDate: "2025-01-01",
      buySellFlag: "B",
      invType: "SP",
      qty: 10526,
      avgPrice: 0,
      total: 0,
      net: 0,
    }));
    expect(ev).toMatchObject({ kind: "ca", qtyDelta: 10526, costDelta: 0 });
  });

  it("drops unknown BuySellFlag instead of inventing a side", () => {
    expect(shareRowToEvent(share({ id: 3, tickerId: "MHAR", invDate: "2024-07-02", buySellFlag: "X", qty: 10, net: 10 }))).toBeNull();
  });

  it("cash as-of is Σ credit − Σ debit and ignores later rows", () => {
    const rows = [
      cash({ id: 1, postDate: "2024-07-01", crAmt: 3_000_000 }),
      cash({ id: 2, postDate: "2024-07-02", dbAmt: 1530 }),
      cash({ id: 3, postDate: "2024-07-10", crAmt: 50 }),
    ];
    expect(cashBalance(rows, "2024-07-02")).toBe(2_998_470);
    expect(cashBalance(rows, "2024-07-01")).toBe(3_000_000);
  });

  it("WAC: two buys then a sell keeps remaining average cost", () => {
    const events = eventsFromShares([
      share({ id: 1, tickerId: "MHAR", invDate: "2024-07-02", buySellFlag: "B", invType: "OI", qty: 1000, net: 1530 }),
      share({ id: 2, tickerId: "MHAR", invDate: "2024-07-02", buySellFlag: "B", invType: "OI", qty: 1_993_508, net: 2_998_459.35 }),
      share({ id: 3, tickerId: "MHAR", invDate: "2024-07-03", buySellFlag: "S", invType: "OC", qty: 1130, net: 1981.4 }),
    ], "2024-07-03");
    const pos = applyReplayEvents(events).get("MHAR")!;
    expect(pos.quantity).toBe(1_993_378);
    const avg = pos.totalCost / pos.quantity;
    expect(avg).toBeCloseTo((1530 + 2_998_459.35) / 1_994_508, 8);
    expect(realizedFromEvents(events)).toBeCloseTo(1981.4 - 1130 * avg, 4);
  });

  it("as-of date excludes later share rows", () => {
    const events = eventsFromShares([
      share({ id: 1, tickerId: "GISS", invDate: "2024-12-24", buySellFlag: "B", qty: 1_300_000, net: 4_207_208.48 }),
      share({ id: 2, tickerId: "GISS", invDate: "2025-01-15", buySellFlag: "S", qty: 100_000, net: 400_000 }),
    ], "2024-12-31");
    expect(applyReplayEvents(events).get("GISS")?.quantity).toBe(1_300_000);
  });

  it("open holding uses last close when provided, else last trade price", () => {
    const shares = [
      share({ id: 1, tickerId: "GISS", companyName: "Gulf International", invDate: "2024-12-24", buySellFlag: "B", qty: 1000, net: 3200 }),
    ];
    const events = eventsFromShares(shares, "2024-12-31");
    const withPx = buildExtHoldings({
      events,
      shares,
      asOf: "2024-12-31",
      cash: 100,
      prices: new Map([["GISS", 3.328]]),
      sectors: new Map([["GISS", "Industry"]]),
      stockIds: new Map([["GISS", "uuid-giss"]]),
    });
    expect(withPx[0].currentPrice).toBe(3.328);
    expect(withPx[0].stockId).toBe("uuid-giss");
    expect(withPx[0].sector).toBe("Industry");

    const noPx = buildExtHoldings({
      events,
      shares,
      asOf: "2024-12-31",
      cash: 0,
      prices: new Map(),
      sectors: new Map(),
      stockIds: new Map(),
    });
    expect(noPx[0].currentPrice).toBe(3.2);
  });

  it("uses CB_SEC_COMP company name when provided", () => {
    const shares = [share({ id: 1, tickerId: "GISS", invDate: "2024-07-02", buySellFlag: "B", qty: 10, net: 32, companyName: "From blotter" })];
    const events = eventsFromShares(shares);
    const holdings = buildExtHoldings({
      events,
      shares,
      asOf: "2024-12-31",
      cash: 0,
      prices: new Map([["GISS", 3]]),
      sectors: new Map([["GISS", "Banks"]]),
      stockIds: new Map(),
      companyNames: new Map([["GISS", "Gulf International Services"]]),
      compIds: new Map([["GISS", 1001]]),
    });
    expect(holdings[0].companyName).toBe("Gulf International Services");
    expect(holdings[0].sector).toBe("Banks");
    expect(holdings[0].compId).toBe(1001);
  });

  it("falls back to share CompId when security-master map is empty", () => {
    const shares = [share({
      id: 1,
      tickerId: "MHAR",
      invDate: "2024-07-02",
      buySellFlag: "B",
      qty: 10,
      net: 15,
      compId: 8037,
    })];
    const holdings = buildExtHoldings({
      events: eventsFromShares(shares),
      shares,
      asOf: "2024-07-02",
      cash: 0,
      prices: new Map([["MHAR", 1.5]]),
      sectors: new Map(),
      stockIds: new Map(),
    });
    expect(holdings[0].compId).toBe(8037);
  });
});

describe("investorDisplayName", () => {
  it("prefers English then Arabic then fallback", () => {
    expect(investorDisplayName({ nameEn: "Acme", nameAr: "أكمي" }, "NIN 1")).toBe("Acme");
    expect(investorDisplayName({ nameEn: "", nameAr: "أكمي" }, "NIN 1")).toBe("أكمي");
    expect(investorDisplayName({}, "NIN 1")).toBe("NIN 1");
    expect(localizedInvestorName({ nameEn: "Acme", nameAr: "أكمي" }, "ar", "x")).toBe("أكمي");
    expect(localizedInvestorName({ nameEn: "Acme", nameAr: "أكمي" }, "en", "x")).toBe("Acme");
  });
});
