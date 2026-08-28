import { describe, expect, it } from "vitest";
import type { ExtShareRow } from "./ext-sql-portfolio.js";
import { assembleRealizedDetails, blotterForPeriod, replayRealizedBlotter } from "./realized-blotter.js";
import { buildInvestorHeader } from "./statement-types.js";
import { UAT_KB_FIRST_MHAR_SELL, UAT_PNL_DETAIL_FIRST_SELL, UAT_PNL_DETAIL_MHAR_OPENING, UAT_SAAD } from "./statement-uat.js";

function share(partial: Partial<ExtShareRow> & Pick<ExtShareRow, "id" | "invDate" | "buySellFlag" | "qty">): ExtShareRow {
  return {
    tickerId: "MHAR",
    companyName: "AL MAHHAR HOLDING COMPANY",
    invType: "OI",
    nin: UAT_SAAD.nin,
    clientId: UAT_SAAD.accountId,
    avgPrice: 0,
    total: 0,
    net: 0,
    totalComm: 0,
    invNo: 1,
    compId: 8037,
    officeComm: 0,
    marketComm: 0,
    originalPrice: 0,
    ...partial,
  };
}

const investor = buildInvestorHeader({
  accountId: UAT_SAAD.accountId,
  nin: UAT_SAAD.nin,
  displayName: UAT_SAAD.nameAr,
  nameAr: UAT_SAAD.nameAr,
  clientCode: UAT_SAAD.clientCode,
});

describe("realized blotter", () => {
  it("matches the PDF first MHAR sell after a 31/12/2025 opening lot", () => {
    const o = UAT_PNL_DETAIL_MHAR_OPENING;
    const s = UAT_PNL_DETAIL_FIRST_SELL;
    const rows = [
      share({ id: 1, invDate: o.date, buySellFlag: "B", qty: o.qty, net: o.book, invType: "OI" }),
      share({ id: 2, invDate: s.date, buySellFlag: "S", qty: s.sellQty, net: s.sellValue, invNo: s.invNo, invType: "OC" }),
    ];
    const period = blotterForPeriod(rows, "2026-01-01", "2026-08-26");
    expect(period).toHaveLength(1);
    const opening = period[0].opening!;
    expect(opening.shareBalance).toBe(o.qty);
    expect(opening.shareCost).toBeCloseTo(o.shareCost, 3);
    expect(opening.buyValue).toBeCloseTo(o.book, 2);
    const sell = period[0].lines[0];
    expect(sell.invNo).toBe(s.invNo);
    expect(sell.sellQty).toBe(s.sellQty);
    expect(sell.shareBalance).toBe(s.balanceAfter);
    expect(sell.grossSaleCost).toBeCloseTo(s.grossSaleCost, 2);
    expect(sell.dayResult).toBeCloseTo(s.dayResult, 2);
    expect(sell.profitLossCumulative).toBeCloseTo(s.dayResult, 2);
    expect(opening.profitLossCumulative).toBe(0);
  });

  it("matches KB first MHAR sell daily result using WAC including commissions", () => {
    const rows = [
      share({ id: 1, invDate: "2024-07-02", buySellFlag: "B", qty: 1000, net: 1530, invNo: 5600088 }),
      share({ id: 2, invDate: "2024-07-02", buySellFlag: "B", qty: 1_993_508, net: 2_998_459.35, invNo: 5600120 }),
      share({
        id: 3,
        invDate: UAT_KB_FIRST_MHAR_SELL.date,
        buySellFlag: "S",
        qty: UAT_KB_FIRST_MHAR_SELL.sellQty,
        net: UAT_KB_FIRST_MHAR_SELL.sellValue,
        invNo: UAT_KB_FIRST_MHAR_SELL.invNo,
        invType: "OC",
      }),
    ];
    const blotter = replayRealizedBlotter(rows);
    const sell = blotter.find((r) => r.invNo === UAT_KB_FIRST_MHAR_SELL.invNo)!;
    expect(sell.dayResult).toBeCloseTo(UAT_KB_FIRST_MHAR_SELL.dailyResult, 2);
    expect(sell.shareCost).toBeCloseTo(UAT_KB_FIRST_MHAR_SELL.shareCost, 4);
  });

  it("buy rows have zero day result and do not change cumulative P/L", () => {
    const rows = [
      share({ id: 1, invDate: "2026-02-26", buySellFlag: "B", qty: 80_000, net: 190_041.18, invNo: 7409006 }),
    ];
    const buy = replayRealizedBlotter(rows)[0];
    expect(buy.side).toBe("Buy");
    expect(buy.dayResult).toBe(0);
    expect(buy.profitLossCumulative).toBe(0);
    expect(buy.buyQty).toBe(80_000);
  });

  it("assembles a details statement grouped by ticker", () => {
    const stmt = assembleRealizedDetails({
      from: "2026-01-01",
      to: "2026-08-26",
      investor,
      shares: [
        share({ id: 1, invDate: "2025-12-31", buySellFlag: "B", qty: 2000, net: 4000 }),
        share({ id: 2, invDate: "2026-01-13", buySellFlag: "S", qty: 100, net: 250 }),
      ],
      printedAtIso: "2026-08-26T05:30:32.000Z",
    });
    expect(stmt.kind).toBe("realized_details");
    expect(stmt.stocks[0].lines[0].isOpening).toBe(true);
    expect(stmt.stocks[0].totals.sellQty).toBe(100);
  });
});
