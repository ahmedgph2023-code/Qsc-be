import { describe, expect, it } from "vitest";
import type { ExtShareRow } from "./ext-sql-portfolio.js";
import { assembleRealizedSummary } from "./realized-summary.js";
import { buildInvestorHeader } from "./statement-types.js";
import { UAT_SAAD } from "./statement-uat.js";

function share(partial: Partial<ExtShareRow> & Pick<ExtShareRow, "id" | "tickerId" | "invDate" | "buySellFlag" | "qty" | "net">): ExtShareRow {
  return {
    companyName: partial.tickerId,
    invType: "OC",
    nin: UAT_SAAD.nin,
    clientId: UAT_SAAD.accountId,
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

describe("realized summary", () => {
  it("sums day results per company and equals the details total", () => {
    const shares = [
      share({ id: 1, tickerId: "MHAR", invDate: "2025-12-31", buySellFlag: "B", qty: 1000, net: 2000, invType: "OI", companyName: "MHAR" }),
      share({ id: 2, tickerId: "MHAR", invDate: "2026-01-13", buySellFlag: "S", qty: 100, net: 250, companyName: "MHAR" }),
      share({ id: 3, tickerId: "GISS", invDate: "2025-12-31", buySellFlag: "B", qty: 100, net: 300, invType: "OI", companyName: "GISS" }),
      share({ id: 4, tickerId: "GISS", invDate: "2026-02-01", buySellFlag: "S", qty: 100, net: 200, companyName: "GISS" }),
    ];
    const stmt = assembleRealizedSummary({
      dates: { mode: "range", from: "2026-01-01", to: "2026-08-26" },
      investor: buildInvestorHeader({
        accountId: UAT_SAAD.accountId,
        nin: UAT_SAAD.nin,
        displayName: UAT_SAAD.nameAr,
      }),
      shares,
      printedAtIso: "2026-08-26T00:00:00.000Z",
    });
    const mhar = stmt.lines.find((l) => l.ticker === "MHAR")!;
    const giss = stmt.lines.find((l) => l.ticker === "GISS")!;
    expect(mhar.tradingProfit).toBeCloseTo(50, 4);
    expect(giss.tradingProfit).toBeCloseTo(-100, 4);
    expect(stmt.tradingProfitTotal).toBeCloseTo(-50, 4);
    expect(stmt.footer.realizedProfitLoss.value).toBe(stmt.tradingProfitTotal);
    expect(stmt.footer.expectedProfitLoss.value).toBeNull();
    expect(mhar.distributedDividends.reason).toBe("DIVIDEND_SOURCE");
  });
});
