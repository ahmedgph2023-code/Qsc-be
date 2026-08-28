import { describe, expect, it } from "vitest";
import { eventsFromShares } from "./ext-sql-portfolio.js";
import { assemblePortfolioStatement, lotsFromShares, portfolioStatementFromLedgers } from "./statement-portfolio.js";
import { buildInvestorHeader } from "./statement-types.js";
import { UAT_PORTFOLIO_2024_12_01, UAT_SAAD } from "./statement-uat.js";

const investor = buildInvestorHeader({
  accountId: UAT_SAAD.accountId,
  nin: UAT_SAAD.nin,
  nameAr: UAT_SAAD.nameAr,
  displayName: UAT_SAAD.nameAr,
  clientCode: UAT_SAAD.clientCode,
});

describe("portfolio statement engine", () => {
  it("values MHAR with official close and does not invent sell commission", () => {
    const p = UAT_PORTFOLIO_2024_12_01;
    const stmt = assemblePortfolioStatement({
      asOf: p.asOf,
      investor,
      lots: [{
        ticker: p.ticker,
        companyName: "AL MAHHAR HOLDING COMPANY",
        sector: "2- Consumer Goods & Services",
        compId: p.compId,
        quantity: p.quantity,
        totalCost: p.costValue,
        avgCost: p.costValue / p.quantity,
      }],
      closes: new Map([[p.ticker, { price: p.closePrice, date: p.asOf }]]),
      cashLedgerBalance: 100,
      realizedToAsOf: p.realizedTradingPl,
      printedAtIso: "2026-08-21T07:51:15.000Z",
    });

    const line = stmt.sectors[0].lines[0];
    expect(line.marketValue).toBe(p.marketValue);
    expect(line.priceSource).toBe("official_close");
    expect(line.compId).toBe(8037);
    expect(line.unrealizedGross).toBeCloseTo(p.marketValue - p.costValue, 2);
    expect(line.displayedProfit.source).toBe("unknown");
    expect(line.displayedProfit.reason).toBe("EXPECTED_SELL_COMM_RULE");
    expect(line.breakEven.reason).toBe("BREAK_EVEN_RULE");
    expect(stmt.grandTotalMarketValue).toBe(p.marketValue);
    expect(stmt.footer.marketValue.value).toBe(p.marketValue);
    expect(stmt.footer.expectedSellCommission.value).toBeNull();
    expect(stmt.footer.netAssetValue.value).toBeNull();
    expect(stmt.footer.cashLedgerBalance.value).toBe(100);
    expect(stmt.footer.realizedTradingPl.value).toBe(p.realizedTradingPl);
    expect(stmt.missingCloses).toEqual([]);
    expect(stmt.footer.drCrBalance.reason).toBe("DR_CR_VS_CASH");
  });

  it("does not treat a prior-day close as the official as-of close", () => {
    const stmt = assemblePortfolioStatement({
      asOf: "2024-12-01",
      investor,
      lots: [{
        ticker: "MHAR",
        companyName: "AL MAHHAR HOLDING COMPANY",
        sector: "Consumer",
        compId: 8037,
        quantity: 1000,
        totalCost: 2000,
        avgCost: 2,
      }],
      closes: new Map([["MHAR", { price: 2.5, date: "2024-11-28" }]]),
      cashLedgerBalance: 0,
      realizedToAsOf: 0,
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    expect(stmt.sectors[0].lines[0].priceSource).toBe("missing_close");
    expect(stmt.sectors[0].lines[0].marketValue).toBeNull();
    expect(stmt.missingCloses).toEqual(["MHAR"]);
  });

  it("does not substitute last trade when official close is missing", () => {
    const stmt = assemblePortfolioStatement({
      asOf: "2024-12-01",
      investor,
      lots: [{
        ticker: "MHAR",
        companyName: "AL MAHHAR HOLDING COMPANY",
        sector: "Consumer",
        compId: 8037,
        quantity: 1000,
        totalCost: 2000,
        avgCost: 2,
      }],
      closes: new Map(),
      cashLedgerBalance: 0,
      realizedToAsOf: 0,
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    const line = stmt.sectors[0].lines[0];
    expect(line.closePrice).toBeNull();
    expect(line.marketValue).toBeNull();
    expect(line.priceSource).toBe("missing_close");
    expect(stmt.grandTotalMarketValue).toBeNull();
    expect(stmt.missingCloses).toEqual(["MHAR"]);
    expect(stmt.footer.marketValue.reason).toBe("MISSING_CLOSE");
  });

  it("builds lots from share blotter without using trade price as close", () => {
    const shares = [{
      id: 1,
      tickerId: "MHAR",
      companyName: "AL MAHHAR HOLDING COMPANY",
      invType: "OI",
      invDate: "2024-07-02",
      buySellFlag: "B",
      nin: UAT_SAAD.nin,
      clientId: UAT_SAAD.accountId,
      qty: UAT_PORTFOLIO_2024_12_01.quantity,
      avgPrice: 0,
      total: 0,
      net: UAT_PORTFOLIO_2024_12_01.costValue,
      totalComm: 0,
      invNo: 1,
      compId: 8037,
      officeComm: 0,
      marketComm: 0,
      originalPrice: 0,
    }];
    const lots = lotsFromShares(shares, "2024-12-01", new Map([["MHAR", "Consumer"]]), new Map());
    expect(lots[0].quantity).toBe(UAT_PORTFOLIO_2024_12_01.quantity);
    expect(lots[0].compId).toBe(8037);
    expect(eventsFromShares(shares, "2024-12-01")).toHaveLength(1);

    const stmt = portfolioStatementFromLedgers({
      asOf: "2024-12-01",
      accountId: UAT_SAAD.accountId,
      shares,
      cash: [{
        id: 1, docCode: "TR", docNo: 1, serNo: 1, nin: UAT_SAAD.nin, mainObjCode: UAT_SAAD.clientCode,
        objCode: UAT_SAAD.accountId, dbAmt: 0, crAmt: 50, remarks: null, eRemarks: null,
        docDate: "2024-07-01", postDate: "2024-07-01", docAmt: 50, status: "P",
      }],
      investor,
      sectors: new Map([["MHAR", "Consumer"]]),
      companyNames: new Map(),
      closes: new Map([["MHAR", { price: 2.508, date: "2024-12-01" }]]),
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    expect(stmt.sectors[0].lines[0].marketValue).toBe(UAT_PORTFOLIO_2024_12_01.marketValue);
    expect(stmt.footer.cashLedgerBalance.value).toBe(50);
  });
});
