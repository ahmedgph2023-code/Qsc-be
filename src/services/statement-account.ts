import {
  cashBalance,
  cashRowsThrough,
  type ExtCashRow,
  type ExtShareRow,
} from "./ext-sql-portfolio.js";
import {
  ACCOUNT_STATEMENT_DISCLAIMER_EN,
  QSC_STATEMENT_COMPANY,
  sqlMoney,
  unknownMoney,
  type AccountStatement,
  type AccountStatementLine,
  type StatementInvestorHeader,
  type StatementMoney,
} from "./statement-types.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type AccountStatementLayout = "grouped" | "detailed";

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

function moneyOrUnknown(value: number | null | undefined, reason: string): StatementMoney {
  if (value == null || !Number.isFinite(value)) return unknownMoney(reason);
  return sqlMoney(value);
}

/** Join cash ↔ share via Invoice Number (+ optional Invoice Type), else DocNo ↔ InvNo. */
export function sharesForCashRow(cash: ExtCashRow, shares: ExtShareRow[]): ExtShareRow[] {
  const invoiceNo = cash.invoiceNo ?? cash.docNo;
  if (invoiceNo == null) return [];
  let matches = shares.filter((s) => s.invNo != null && Number(s.invNo) === Number(invoiceNo));
  const invType = (cash.invoiceType || "").trim();
  if (invType && matches.length > 1) {
    const typed = matches.filter((s) => s.invType.trim().toUpperCase() === invType.toUpperCase());
    if (typed.length) matches = typed;
  }
  return matches;
}

export function securityFieldsFromShares(shares: ExtShareRow[]): {
  quantity: number | null;
  avgPrice: number | null;
  marketFees: number | null;
  commission: number | null;
  priceWithComm: number | null;
} {
  if (!shares.length) {
    return {
      quantity: null,
      avgPrice: null,
      marketFees: null,
      commission: null,
      priceWithComm: null,
    };
  }
  const quantity = round4(shares.reduce((s, r) => s + r.qty, 0));
  const costBasis = shares.reduce((s, r) => s + (r.avgPrice * r.qty), 0);
  const avgPrice = quantity > 0 ? round4(costBasis / quantity) : null;
  const marketFees = round4(shares.reduce((s, r) => s + r.marketComm, 0));
  const commission = round4(shares.reduce((s, r) => s + r.officeComm + r.totalComm, 0));
  const net = shares.reduce((s, r) => s + r.net, 0);
  const priceWithComm = quantity > 0 ? round4(Math.abs(net) / quantity) : null;
  return { quantity, avgPrice, marketFees, commission, priceWithComm };
}

function lineFromCash(
  row: ExtCashRow,
  running: number,
  shares: ExtShareRow[],
): AccountStatementLine {
  const sec = securityFieldsFromShares(shares);
  return {
    postDate: row.postDate,
    docDate: row.docDate,
    transType: row.docCode || "",
    transNo: row.docNo,
    description: (row.eRemarks || row.remarks || "").trim() || row.docCode,
    quantity: sec.quantity,
    securityPrice: moneyOrUnknown(sec.avgPrice, "ACCOUNT_SECURITY_COLS"),
    securityPriceWithComm: moneyOrUnknown(sec.priceWithComm, "ACCOUNT_SECURITY_COLS"),
    marketFees: moneyOrUnknown(sec.marketFees, "ACCOUNT_SECURITY_COLS"),
    commission: moneyOrUnknown(sec.commission, "ACCOUNT_SECURITY_COLS"),
    debit: row.dbAmt,
    credit: row.crAmt,
    balance: running,
    status: row.status,
    isOpening: false,
    isUnposted: isUnposted(row.status),
  };
}

function isSecurityTradeLine(line: AccountStatementLine): boolean {
  if (line.quantity != null && line.quantity !== 0) return true;
  const desc = line.description.trim().toLowerCase();
  return /\b(buy|sell)\b/.test(desc) && /\bsecurit/.test(desc);
}

function securityGroupKey(line: AccountStatementLine): string {
  return `${line.description.trim().toLowerCase()}|${line.status.trim().toUpperCase()}`;
}

/**
 * Group buy/sell lines that share the same transaction description
 * (client sample: all "Sell Securities of DHBK" → one row).
 * Does not require invoice qty — description match is enough.
 */
export function groupAccountMovementLines(lines: AccountStatementLine[]): AccountStatementLine[] {
  const security: AccountStatementLine[] = [];
  const other: AccountStatementLine[] = [];
  for (const line of lines) {
    if (isSecurityTradeLine(line)) security.push(line);
    else other.push(line);
  }

  const buckets = new Map<string, AccountStatementLine[]>();
  for (const line of security) {
    const key = securityGroupKey(line);
    const list = buckets.get(key) || [];
    list.push(line);
    buckets.set(key, list);
  }

  const groupedSecurity: AccountStatementLine[] = [];
  for (const group of buckets.values()) {
    if (group.length === 1) {
      groupedSecurity.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) =>
      a.postDate === b.postDate
        ? (a.transNo ?? 0) - (b.transNo ?? 0)
        : a.postDate.localeCompare(b.postDate),
    );
    const qtyParts = sorted.map((g) => g.quantity).filter((q): q is number => q != null);
    const qty = qtyParts.length ? round4(qtyParts.reduce((s, q) => s + q, 0)) : null;
    const weighted = qty != null && qty > 0
      ? round4(sorted.reduce((s, g) => {
        const p = g.securityPrice.source !== "unknown" ? (g.securityPrice.value ?? 0) : 0;
        return s + p * (g.quantity ?? 0);
      }, 0) / qty)
      : null;
    const priceFallback = sorted
      .map((g) => (g.securityPrice.source !== "unknown" ? g.securityPrice.value : null))
      .find((v): v is number => v != null) ?? null;
    groupedSecurity.push({
      ...sorted[0],
      postDate: sorted[0].postDate,
      docDate: sorted[sorted.length - 1].docDate,
      transNo: sorted[0].transNo,
      quantity: qty,
      securityPrice: moneyOrUnknown(weighted ?? priceFallback, "ACCOUNT_SECURITY_COLS"),
      debit: round4(sorted.reduce((s, g) => s + g.debit, 0)),
      credit: round4(sorted.reduce((s, g) => s + g.credit, 0)),
      balance: sorted[sorted.length - 1].balance,
      isUnposted: sorted.some((g) => g.isUnposted),
    });
  }

  return [...other, ...groupedSecurity].sort((a, b) => {
    if (a.postDate !== b.postDate) return a.postDate.localeCompare(b.postDate);
    return (a.transNo ?? 0) - (b.transNo ?? 0);
  });
}

function recomputeRunningBalances(openingBalance: number, lines: AccountStatementLine[]): AccountStatementLine[] {
  let running = openingBalance;
  return lines.map((line) => {
    if (line.isOpening) {
      return { ...line, balance: openingBalance };
    }
    running = round4(running + line.credit - line.debit);
    return { ...line, balance: running };
  });
}

export function assembleAccountStatement(input: {
  from: string;
  to: string;
  investor: StatementInvestorHeader;
  cash: ExtCashRow[];
  shares?: ExtShareRow[];
  layout?: AccountStatementLayout;
  printedAtIso: string;
}): AccountStatement {
  const layout: AccountStatementLayout = input.layout === "detailed" ? "detailed" : "grouped";
  const shares = input.shares ?? [];
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
  let movementLines: AccountStatementLine[] = period.map((row) => {
    running = round4(running + row.crAmt - row.dbAmt);
    return lineFromCash(row, running, sharesForCashRow(row, shares));
  });

  if (layout === "grouped") {
    movementLines = recomputeRunningBalances(openingBalance, groupAccountMovementLines(movementLines));
  }

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
    layout,
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
