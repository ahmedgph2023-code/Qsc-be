import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATEMENT_DISCLAIMER_EN,
  INVESTOR_HEADER_SQL_GAPS,
  KB_SAMPLE_INVESTOR_37808,
  QSC_STATEMENT_COMPANY,
  STATEMENT_KINDS,
  applySampleInvestorKbHeader,
  buildInvestorHeader,
  unknownMoney,
} from "./statement-types.js";
import {
  UAT_KB_2024_12_31,
  UAT_PNL_DETAIL_FIRST_SELL,
  UAT_PNL_DETAIL_MHAR_OPENING,
  UAT_PNL_SUMMARY_2026_08_26,
  UAT_PORTFOLIO_2024_12_01,
  UAT_SAAD,
} from "./statement-uat.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("statement contracts", () => {
  it("names the four report kinds", () => {
    expect(STATEMENT_KINDS).toEqual([
      "portfolio",
      "account",
      "realized_summary",
      "realized_details",
    ]);
  });

  it("keeps QSC print header constants", () => {
    expect(QSC_STATEMENT_COMPANY.legalName).toBe("Qatar Securities Co. (P.Q.S.C)");
    expect(QSC_STATEMENT_COMPANY.logoPath).toBe("/logo.png");
    expect(ACCOUNT_STATEMENT_DISCLAIMER_EN).toMatch(/5 business days/);
  });

  it("lists investor header fields that live SQL cannot source", () => {
    expect(INVESTOR_HEADER_SQL_GAPS).toContain("poBox");
    expect(INVESTOR_HEADER_SQL_GAPS).toContain("tradingAccountQe");
    expect(unknownMoney("EXPECTED_SELL_COMM_RULE").value).toBeNull();
    const header = buildInvestorHeader({
      accountId: UAT_SAAD.accountId,
      nin: UAT_SAAD.nin,
      nameAr: UAT_SAAD.nameAr,
      displayName: UAT_SAAD.nameAr,
      clientCode: UAT_SAAD.clientCode,
      cAccount: "RAW",
    });
    expect(header.cAccount).toBe("RAW");
    expect(header.poBox).toBeNull();
    expect(header.tradingAccountQe).toBeNull();
    expect(header.currency).toBe("QAR");
  });

  it("fills sample 37808 print fields from KB / UAT freeze without copying to other NINs", () => {
    const sample = applySampleInvestorKbHeader(buildInvestorHeader({
      accountId: UAT_SAAD.accountId,
      nin: UAT_SAAD.nin,
      displayName: UAT_SAAD.nameAr,
    }));
    expect(sample.poBox).toBe(KB_SAMPLE_INVESTOR_37808.poBox);
    expect(sample.city).toBe("DOHA");
    expect(sample.country).toBe("QATAR");
    expect(sample.accountTypePrinted).toBe("INV PORT");
    expect(sample.fax).toBe(KB_SAMPLE_INVESTOR_37808.fax);
    expect(sample.tradingAccountQe).toBe(KB_SAMPLE_INVESTOR_37808.tradingAccountQe);

    const other = applySampleInvestorKbHeader(buildInvestorHeader({
      accountId: 1,
      nin: "99999",
      displayName: "other",
    }));
    expect(other.poBox).toBeNull();
    expect(other.accountTypePrinted).toBeNull();
  });
});

describe("UAT freeze identities (observed on samples, not policy)", () => {
  it("keys the reconstruction client", () => {
    expect(UAT_SAAD.nin).toBe("37808");
    expect(UAT_SAAD.accountId).toBe(2041929);
  });

  it("portfolio 01/12/2024: qty × close = MV", () => {
    const p = UAT_PORTFOLIO_2024_12_01;
    expect(p.quantity * p.closePrice).toBe(p.marketValue);
  });

  it("portfolio 01/12/2024: displayed profit = MV − cost − expected sell comm", () => {
    const p = UAT_PORTFOLIO_2024_12_01;
    expect(round2(p.marketValue - p.costValue - p.expectedSellComm)).toBe(p.profitPrinted);
  });

  it("portfolio 01/12/2024: NAV = MV + Dr/Cr (not client net cash)", () => {
    const p = UAT_PORTFOLIO_2024_12_01;
    expect(round2(p.marketValue + p.drCrBalance)).toBe(p.nav);
    expect(p.clientNetCash).not.toBe(p.drCrBalance);
  });

  it("portfolio 01/12/2024: net P/L = expected + realized", () => {
    const p = UAT_PORTFOLIO_2024_12_01;
    expect(round2(p.profitPrinted + p.realizedTradingPl)).toBe(p.netProfitLoss);
  });

  it("KB 31/12/2024: cash + MV = NAV", () => {
    const k = UAT_KB_2024_12_31;
    expect(round2(k.marketValue + k.cash)).toBe(k.nav);
  });

  it("KB 31/12/2024: qty × close = MV", () => {
    const k = UAT_KB_2024_12_31;
    expect(k.quantity * k.close).toBe(k.marketValue);
  });

  it("P&L summary: trading legs sum to total; net = realized + expected", () => {
    const s = UAT_PNL_SUMMARY_2026_08_26;
    expect(round2(s.mhar + s.giss + s.mcgs + s.qfls)).toBe(s.tradingTotal);
    expect(round2(s.tradingTotal + s.expectedPl)).toBe(s.netPl);
    expect(round2(s.commission + s.endOfPeriodBalance + s.drCrBalance)).toBe(s.footerTotal);
    expect(s.period).toBe("UNKNOWN");
  });

  it("P&L detail first MHAR sell identities", () => {
    const o = UAT_PNL_DETAIL_MHAR_OPENING;
    const s = UAT_PNL_DETAIL_FIRST_SELL;
    expect(o.book / o.qty).toBeCloseTo(o.shareCost, 3);
    expect(round2(s.sellValue - s.grossSaleCost)).toBe(s.dayResult);
    expect(s.grossSaleCost / s.sellQty).toBeCloseTo(s.shareCost, 3);
    expect(round2(o.cumulativePl + s.dayResult)).toBe(s.cumulativeAfter);
    expect(o.qty - s.sellQty).toBe(s.balanceAfter);
  });
});
