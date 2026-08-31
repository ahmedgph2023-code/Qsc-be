import { describe, expect, it } from "vitest";
import XLSX from "xlsx";
import StyleXLSX from "xlsx-js-style";
import { statementWorkbook } from "./statement-excel.js";
import { assembleRealizedSummary } from "./realized-summary.js";
import { assemblePortfolioStatement } from "./statement-portfolio.js";
import { buildInvestorHeader } from "./statement-types.js";
import type { ExtShareRow } from "./ext-sql-portfolio.js";

function share(partial: Partial<ExtShareRow> & Pick<ExtShareRow, "id" | "tickerId" | "invDate" | "buySellFlag" | "qty" | "net">): ExtShareRow {
  return {
    companyName: partial.tickerId,
    invType: "OC",
    nin: "37808",
    clientId: 2041929,
    avgPrice: 0,
    total: 0,
    totalComm: 0,
    invNo: partial.id,
    compId: 1,
    officeComm: 0,
    marketComm: 0,
    originalPrice: 0,
    ...partial,
  };
}

function sheetText(buffer: Buffer) {
  const wb = XLSX.read(buffer);
  expect(wb.SheetNames).toHaveLength(1);
  return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
}

describe("statement excel", () => {
  it("puts header, lines, and recap on one Summary sheet", () => {
    const stmt = assembleRealizedSummary({
      dates: { mode: "range", from: "2026-01-01", to: "2026-08-26" },
      investor: buildInvestorHeader({ accountId: 2041929, nin: "37808", displayName: "test" }),
      shares: [
        share({ id: 1, tickerId: "MHAR", invDate: "2026-01-13", buySellFlag: "B", qty: 100, net: 200 }),
        share({ id: 2, tickerId: "MHAR", invDate: "2026-01-14", buySellFlag: "S", qty: 100, net: 250 }),
      ],
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    const { filename, buffer } = statementWorkbook(stmt);
    expect(filename).toBe("37808_RealizedProfitLossSummary.xlsx");
    const csv = sheetText(buffer).replace(/,/g, "");
    expect(csv).toContain("37808");
    expect(csv).toContain("MHAR");
    expect(csv).toContain("Trading Profit");
    expect(csv).toContain("Realized Profit/Loss");
    expect(csv).not.toContain("Header");
  });

  it("puts identity, holdings, ticker, and PDF recap on one Portfolio sheet", () => {
    const stmt = assemblePortfolioStatement({
      asOf: "2024-12-01",
      investor: buildInvestorHeader({ accountId: 2041929, nin: "37808", displayName: "SAAD" }),
      lots: [{
        ticker: "MHAR",
        companyName: "AL MAHHAR HOLDING COMPANY",
        sector: "Consumer",
        compId: 8037,
        quantity: 1000,
        totalCost: 2000,
        avgCost: 2,
      }],
      closes: new Map([["MHAR", { price: 2.5, date: "2024-12-01" }]]),
      cashLedgerBalance: 170494.61,
      realizedToAsOf: 15136.16,
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    const { filename, buffer } = statementWorkbook(stmt);
    expect(filename).toBe("37808_PortfolioStatement.xlsx");
    const wb = XLSX.read(buffer);
    expect(wb.SheetNames).toEqual(["Portfolio"]);
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets.Portfolio).replace(/,/g, "");
    expect(csv).toContain("SAAD");
    expect(csv).toContain("MHAR");
    expect(csv).toContain("AL MAHHAR HOLDING COMPANY");
    expect(csv).toContain("Cash Ledger");
    expect(csv).toContain("170494.61");
    expect(csv).toContain("Realized Trading P/L");
    expect(csv).toContain("15136.16");
    expect(csv).toContain("Expected Sell Commission");
    expect(csv).toContain("Net Asset Value");
    expect(csv).toContain("TOTAL");
    const styled = StyleXLSX.read(buffer, { type: "buffer", cellStyles: true });
    const header = Object.keys(styled.Sheets.Portfolio).find((addr) => styled.Sheets.Portfolio[addr]?.v === "Company");
    expect(header).toBeTruthy();
    expect(String(styled.Sheets.Portfolio[header!].s?.fgColor?.rgb || "")).toMatch(/0B1F4A/i);
    expect(styled.Sheets.Portfolio["!cols"]?.[0]?.wch).toBeGreaterThanOrEqual(36);
  });
});
