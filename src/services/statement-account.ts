import { cashBalance, cashRowsThrough, type ExtCashRow } from "./ext-sql-portfolio.js";
import {
  ACCOUNT_STATEMENT_DISCLAIMER_EN,
  QSC_STATEMENT_COMPANY,
  unknownMoney,
  type AccountStatement,
  type AccountStatementLine,
  type StatementInvestorHeader,
} from "./statement-types.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function dayBefore(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export function periodCashRows(rows: ExtCashRow[], from: string, to: string): ExtCashRow[] {
  return cashRowsThrough(rows, to).filter((row) => row.postDate >= from);
}

export function openingCashBalance(rows: ExtCashRow[], from: string): number {
  return cashBalance(rows, dayBefore(from));
}

function isUnposted(status: string): boolean {
  return status.trim().toUpperCase() !== "P";
}

export function assembleAccountStatement(input: {
  from: string;
  to: string;
  investor: StatementInvestorHeader;
  cash: ExtCashRow[];
  printedAtIso: string;
}): AccountStatement {
  const openingBalance = openingCashBalance(input.cash, input.from);
  const period = periodCashRows(input.cash, input.from, input.to);
  const openingDate = period[0]
    ? dayBefore(input.from)
    : (cashRowsThrough(input.cash, dayBefore(input.from)).at(-1)?.postDate ?? null);

  const openingLine: AccountStatementLine = {
    postDate: openingDate || dayBefore(input.from),
    docDate: openingDate || dayBefore(input.from),
    transType: "ST",
    transNo: null,
    description: "Opening Balance",
    quantity: null,
    securityPrice: unknownMoney("ACCOUNT_SECURITY_COLS"),
    securityPriceWithComm: unknownMoney("ACCOUNT_SECURITY_COLS"),
    marketFees: unknownMoney("ACCOUNT_SECURITY_COLS"),
    commission: unknownMoney("ACCOUNT_SECURITY_COLS"),
    debit: 0,
    credit: 0,
    balance: openingBalance,
    status: "P",
    isOpening: true,
    isUnposted: false,
  };

  let running = openingBalance;
  const movementLines: AccountStatementLine[] = period.map((row) => {
    running = round4(running + row.crAmt - row.dbAmt);
    return {
      postDate: row.postDate,
      docDate: row.docDate,
      transType: row.docCode || "",
      transNo: row.docNo,
      description: (row.eRemarks || row.remarks || "").trim() || row.docCode,
      quantity: null,
      securityPrice: unknownMoney("ACCOUNT_SECURITY_COLS"),
      securityPriceWithComm: unknownMoney("ACCOUNT_SECURITY_COLS"),
      marketFees: unknownMoney("ACCOUNT_SECURITY_COLS"),
      commission: unknownMoney("ACCOUNT_SECURITY_COLS"),
      debit: row.dbAmt,
      credit: row.crAmt,
      balance: running,
      status: row.status,
      isOpening: false,
      isUnposted: isUnposted(row.status),
    };
  });

  const lines = [openingLine, ...movementLines];
  const unposted = movementLines.filter((l) => l.isUnposted);
  const postedClosing = movementLines.filter((l) => !l.isUnposted);
  const closingBalance = postedClosing.length
    ? postedClosing[postedClosing.length - 1].balance
    : openingBalance;

  return {
    kind: "account",
    titleEn: "Statement of Account",
    titleAr: "كشف الحساب",
    company: QSC_STATEMENT_COMPANY,
    investor: input.investor,
    dates: { mode: "range", from: input.from, to: input.to },
    openingBalance,
    openingDate: openingLine.postDate,
    lines,
    unpostedDebit: round4(unposted.reduce((s, l) => s + l.debit, 0)),
    unpostedCredit: round4(unposted.reduce((s, l) => s + l.credit, 0)),
    closingBalance,
    transactionCount: movementLines.length,
    disclaimerEn: ACCOUNT_STATEMENT_DISCLAIMER_EN,
    print: { printedAtIso: input.printedAtIso, page: null },
  };
}
