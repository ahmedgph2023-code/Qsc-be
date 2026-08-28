import { describe, expect, it } from "vitest";
import { statementWorkbook } from "./statement-excel.js";
import { assembleRealizedSummary } from "./realized-summary.js";
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

describe("statement excel", () => {
  it("names the summary workbook after NIN and includes a Summary sheet", () => {
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
    expect(buffer.length).toBeGreaterThan(100);
  });
});
