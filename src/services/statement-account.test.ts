import { describe, expect, it } from "vitest";
import type { ExtCashRow } from "./ext-sql-portfolio.js";
import { assembleAccountStatement, dayBefore, openingCashBalance, periodCashRows } from "./statement-account.js";
import { buildInvestorHeader } from "./statement-types.js";
import { UAT_ACCOUNT_LAYOUT_ONLY, UAT_SAAD } from "./statement-uat.js";

function cash(partial: Partial<ExtCashRow> & Pick<ExtCashRow, "id" | "postDate">): ExtCashRow {
  return {
    docCode: "JV",
    docNo: 1,
    serNo: 1,
    nin: UAT_SAAD.nin,
    mainObjCode: UAT_SAAD.clientCode,
    objCode: UAT_SAAD.accountId,
    dbAmt: 0,
    crAmt: 0,
    remarks: null,
    eRemarks: null,
    docDate: partial.postDate,
    docAmt: 0,
    status: "P",
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

describe("account statement period cash", () => {
  it("dayBefore stays on the calendar date", () => {
    expect(dayBefore("2025-05-11")).toBe("2025-05-10");
    expect(dayBefore("2025-01-01")).toBe("2024-12-31");
  });

  it("opening balance is cash through the day before from", () => {
    const rows = [
      cash({ id: 1, postDate: "2025-05-10", crAmt: 1.79, eRemarks: "Opening" }),
      cash({ id: 2, postDate: "2025-05-11", crAmt: 10 }),
      cash({ id: 3, postDate: "2025-05-13", crAmt: 5 }),
    ];
    expect(openingCashBalance(rows, "2025-05-11")).toBe(1.79);
    expect(periodCashRows(rows, "2025-05-11", "2025-05-12")).toHaveLength(1);
  });

  it("continues running balance from opening and does not restart at 0", () => {
    const rows = [
      cash({ id: 1, postDate: "2025-05-10", crAmt: 1.79 }),
      cash({ id: 2, postDate: "2025-05-11", dbAmt: 0.5, eRemarks: "Fee" }),
      cash({ id: 3, postDate: "2025-05-12", crAmt: 2, status: "A", eRemarks: "Unposted" }),
    ];
    const stmt = assembleAccountStatement({
      from: "2025-05-11",
      to: "2025-05-12",
      investor,
      cash: rows,
      printedAtIso: "2025-05-12T03:39:15.000Z",
    });
    expect(stmt.openingBalance).toBe(1.79);
    expect(stmt.lines[0].isOpening).toBe(true);
    expect(stmt.lines[0].description).toBe("Opening Balance");
    expect(stmt.lines[1].balance).toBe(1.29);
    expect(stmt.lines[1].debit).toBe(0.5);
    expect(stmt.lines[2].isUnposted).toBe(true);
    expect(stmt.unpostedCredit).toBe(2);
    expect(stmt.closingBalance).toBe(1.29);
    expect(stmt.transactionCount).toBe(2);
    expect(stmt.disclaimerEn).toMatch(/5 business days/);
    expect(stmt.lines[1].commission.source).toBe("unknown");
  });

  it("matches the layout sample opening of 1.79 with no period movements", () => {
    const rows = [cash({ id: 1, postDate: "2025-05-10", crAmt: UAT_ACCOUNT_LAYOUT_ONLY.opening, docCode: "ST" })];
    const stmt = assembleAccountStatement({
      from: UAT_ACCOUNT_LAYOUT_ONLY.from,
      to: UAT_ACCOUNT_LAYOUT_ONLY.to,
      investor,
      cash: rows,
      printedAtIso: "2025-05-12T03:39:15.000Z",
    });
    expect(stmt.openingBalance).toBe(1.79);
    expect(stmt.closingBalance).toBe(1.79);
    expect(stmt.transactionCount).toBe(0);
    expect(stmt.lines).toHaveLength(1);
  });
});
