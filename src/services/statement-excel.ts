import XLSX from "xlsx-js-style";
import type {
  AccountStatement,
  ClientStatement,
  PortfolioStatement,
  RealizedDetailsStatement,
  RealizedSummaryStatement,
  StatementMoney,
} from "./statement-types.js";

type Cell = string | number | "";
type RowKind =
  | "title"
  | "subtitle"
  | "meta"
  | "blank"
  | "identity"
  | "header"
  | "sector"
  | "data"
  | "total"
  | "recap"
  | "note";

type StyledRow = { kind: RowKind; cells: Cell[]; stripe?: boolean };

type CellStyle = {
  font?: { bold?: boolean; italic?: boolean; color?: { rgb: string }; name?: string; sz?: number };
  fill?: { patternType: "solid"; fgColor: { rgb: string } };
  alignment?: { horizontal?: "left" | "center" | "right"; vertical?: "center"; wrapText?: boolean };
  border?: Record<"top" | "bottom" | "left" | "right", { style: string; color: { rgb: string } }>;
  numFmt?: string;
};

const NAVY = "0B1F4A";
const INK = "16305F";
const MUTED = "657491";
const WHITE = "FFFFFF";
const SECTOR_BG = "EEF3FF";
const STRIPE_BG = "F7F9FD";
const LABEL_BG = "F0F4FA";
const GRID = "D7E0EE";
const FONT = "Calibri";
const NUM_FMT = "#,##0.00";

const thin = { style: "thin", color: { rgb: GRID } };
const border = { top: thin, bottom: thin, left: thin, right: thin };

function money(m: StatementMoney): Cell {
  return m.value == null ? "" : m.value;
}

function num(n: number | null | undefined): Cell {
  return n == null ? "" : n;
}

function filenameFor(stmt: ClientStatement): string {
  const nin = stmt.investor.nin || String(stmt.investor.accountId);
  if (stmt.kind === "portfolio") return `${nin}_PortfolioStatement.xlsx`;
  if (stmt.kind === "account") return `${nin}_StatementOfAccounts.xlsx`;
  if (stmt.kind === "realized_summary") return `${nin}_RealizedProfitLossSummary.xlsx`;
  return `${nin}_RealizedProfitLossTransactionDetails.xlsx`;
}

function sheetName(stmt: ClientStatement) {
  if (stmt.kind === "portfolio") return "Portfolio";
  if (stmt.kind === "account") return "Account";
  if (stmt.kind === "realized_summary") return "Summary";
  return "Details";
}

function periodLine(stmt: ClientStatement): string {
  if (stmt.kind === "portfolio") return `Closing Prices as of ${stmt.closingPricesAsOf}`;
  if (stmt.dates.mode === "as_of") return `As of ${stmt.dates.asOf}`;
  return `From ${stmt.dates.from} To ${stmt.dates.to}`;
}

function formatPrintedAt(iso: string | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Qatar",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function identityRows(stmt: ClientStatement): StyledRow[] {
  const inv = stmt.investor;
  return [
    { kind: "title", cells: [stmt.company?.legalName ?? ""] },
    { kind: "subtitle", cells: [stmt.titleEn] },
    { kind: "subtitle", cells: [stmt.titleAr] },
    { kind: "meta", cells: [periodLine(stmt)] },
    { kind: "blank", cells: [] },
    { kind: "identity", cells: ["Client Name", inv.displayName || inv.nameEn || inv.nameAr, "Client No.", inv.clientCode ?? "", "NIN", inv.nin] },
    { kind: "identity", cells: ["Account", inv.accountId, "Currency", inv.currency, "C_ACCOUNT", inv.cAccount ?? ""] },
    { kind: "identity", cells: ["P.O.Box", inv.poBox ?? "", "Tel", inv.tel ?? "", "Fax", inv.fax ?? ""] },
    { kind: "identity", cells: ["Address", inv.address ?? "", "City", inv.city ?? "", "Country", inv.country ?? ""] },
    { kind: "identity", cells: ["Mobile", inv.mobile ?? "", "Client type (raw)", inv.clientType ?? "", "Printed at", formatPrintedAt(stmt.print?.printedAtIso)] },
    { kind: "blank", cells: [] },
  ];
}

function recapRows(pairs: Array<[string, Cell]>): StyledRow[] {
  return [{ kind: "blank", cells: [] }, ...pairs.map(([label, value]) => ({ kind: "recap" as const, cells: [label, value] }))];
}

function portfolioRows(stmt: PortfolioStatement): { rows: StyledRow[]; mins: number[] } {
  const rows: StyledRow[] = [
    ...identityRows(stmt),
    {
      kind: "header",
      cells: [
        "Company",
        "Ticker",
        "Currency",
        "Code",
        "Type",
        "Shares",
        "Shares Value",
        "Share Cost",
        "Break Even",
        "Close Price",
        "Close Date",
        "Market Value",
        "Profit",
        "Profit %",
        "Currency Diff",
      ],
    },
  ];
  let qty = 0;
  let stripe = false;
  for (const sector of stmt.sectors) {
    rows.push({ kind: "sector", cells: [sector.sectorName] });
    for (const line of sector.lines) {
      qty += line.quantity;
      rows.push({
        kind: "data",
        stripe,
        cells: [
          line.companyName,
          line.ticker,
          line.currency,
          line.compId ?? "",
          line.accountTypePrinted ?? "",
          line.quantity,
          line.costValue,
          line.shareCost,
          money(line.breakEven),
          line.priceSource === "missing_close" ? "" : num(line.closePrice),
          line.closeDate ?? "",
          num(line.marketValue),
          money(line.displayedProfit),
          money(line.displayedProfitPct),
          line.currencyDifference,
        ],
      });
      stripe = !stripe;
    }
  }
  rows.push({
    kind: "total",
    cells: ["TOTAL", "", "", "", "", qty, stmt.grandTotalCost, "", "", "", "", num(stmt.grandTotalMarketValue), "", "", ""],
  });
  rows.push(
    ...recapRows([
      ["Total Cost", stmt.grandTotalCost],
      ["Market Value", num(stmt.grandTotalMarketValue)],
      ["Expected Profit/Loss", money(stmt.footer.expectedProfitLoss)],
      ["Expected Sell Commission", money(stmt.footer.expectedSellCommission)],
      ["Net (after expected sell commission)", money(stmt.footer.netAfterExpectedSellComm)],
      ["Currency Difference", money(stmt.footer.currencyDifference)],
      ["Dr/Cr Balance", money(stmt.footer.drCrBalance)],
      ["Realized Trading P/L", money(stmt.footer.realizedTradingPl)],
      ["Received Profits", money(stmt.footer.receivedProfits)],
      ["Non-Received Profits", money(stmt.footer.nonReceivedProfits)],
      ["Realized total", money(stmt.footer.realizedTotal)],
      ["Client Net Cash Balance", money(stmt.footer.clientNetCashBalance)],
      ["Net Profit/Loss", money(stmt.footer.netProfitLoss)],
      ["Net Asset Value", money(stmt.footer.netAssetValue)],
      ["Cash Ledger", money(stmt.footer.cashLedgerBalance)],
    ]),
  );
  if (stmt.missingCloses.length > 0) {
    rows.push({ kind: "blank", cells: [] }, { kind: "note", cells: ["Missing official closes", stmt.missingCloses.join(", ")] });
  }
  return { rows, mins: [38, 12, 12, 10, 12, 14, 16, 14, 14, 14, 14, 16, 14, 12, 16] };
}

function accountRows(stmt: AccountStatement): { rows: StyledRow[]; mins: number[] } {
  const rows: StyledRow[] = [
    ...identityRows(stmt),
    {
      kind: "header",
      cells: [
        "Post Date",
        "Transaction Type",
        "Transaction No.",
        "Description",
        "Quantity",
        "Security Price",
        "Price with Commission",
        "Market Fees",
        "Commission",
        "Debit",
        "Credit",
        "Balance",
        "Document Date",
        "Status",
      ],
    },
    ...stmt.lines.map((line, i) => ({
      kind: "data" as const,
      stripe: i % 2 === 1,
      cells: [
        line.postDate,
        line.transType,
        line.transNo ?? "",
        line.description,
        num(line.quantity),
        money(line.securityPrice),
        money(line.securityPriceWithComm),
        money(line.marketFees),
        money(line.commission),
        line.debit,
        line.credit,
        line.balance,
        line.docDate,
        line.status,
      ],
    })),
    { kind: "blank", cells: [] },
    { kind: "recap", cells: ["Opening", stmt.openingBalance, "Opening date", stmt.openingDate ?? ""] },
    { kind: "recap", cells: ["Unposted Debit", stmt.unpostedDebit, "Unposted Credit", stmt.unpostedCredit] },
    { kind: "recap", cells: ["Closing", stmt.closingBalance, "Transactions", stmt.transactionCount] },
    { kind: "blank", cells: [] },
    { kind: "note", cells: ["Disclaimer", stmt.disclaimerEn] },
  ];
  return { rows, mins: [14, 18, 16, 42, 12, 16, 22, 14, 14, 14, 14, 14, 16, 12] };
}

function summaryRows(stmt: RealizedSummaryStatement): { rows: StyledRow[]; mins: number[] } {
  const rows: StyledRow[] = [
    ...identityRows(stmt),
    {
      kind: "header",
      cells: ["Company", "Ticker", "Code", "Type", "Trading Profit"],
    },
    ...stmt.lines.map((line, i) => ({
      kind: "data" as const,
      stripe: i % 2 === 1,
      cells: [
        line.companyName,
        line.ticker,
        line.compId ?? "",
        line.accountTypePrinted ?? "",
        line.tradingProfit,
      ],
    })),
    { kind: "total", cells: ["TOTAL", "", "", "", stmt.tradingProfitTotal] },
    ...recapRows([
      ["Realized Profit/Loss", money(stmt.footer.realizedProfitLoss)],
    ]),
  ];
  return { rows, mins: [36, 12, 10, 12, 16] };
}

function detailsRows(stmt: RealizedDetailsStatement): { rows: StyledRow[]; mins: number[] } {
  const rows: StyledRow[] = [...identityRows(stmt)];
  for (const stock of stmt.stocks) {
    rows.push({ kind: "sector", cells: [`${stock.companyName} · ${stock.ticker} · ${stock.compId ?? ""} · ${stock.currency}`] });
    rows.push({
      kind: "header",
      cells: [
        "Date",
        "Invoice No.",
        "Side",
        "Buy Qty",
        "Sell Qty",
        "Share Balance",
        "Price",
        "Buy Value",
        "Sell Value",
        "Share Cost",
        "Gross Sale Cost",
        "Day Result",
        "Profit / Loss",
      ],
    });
    stock.lines.forEach((line, i) => {
      rows.push({
        kind: "data",
        stripe: i % 2 === 1,
        cells: [
          line.date,
          line.invNo ?? "",
          line.side,
          line.buyQty,
          line.sellQty,
          line.shareBalance,
          line.price,
          line.buyValue,
          line.sellValue,
          line.shareCost,
          line.grossSaleCost,
          line.dayResult,
          line.profitLossCumulative,
        ],
      });
    });
    rows.push({
      kind: "total",
      cells: ["TOTAL", "", "", stock.totals.buyQty, stock.totals.sellQty, "", "", stock.totals.buyValue, stock.totals.sellValue, "", "", stock.totals.dayResult, ""],
    });
    rows.push({ kind: "blank", cells: [] });
  }
  return { rows, mins: [14, 14, 10, 12, 12, 16, 12, 14, 14, 14, 18, 14, 16] };
}

function layoutFor(stmt: ClientStatement) {
  if (stmt.kind === "portfolio") return portfolioRows(stmt);
  if (stmt.kind === "account") return accountRows(stmt);
  if (stmt.kind === "realized_summary") return summaryRows(stmt);
  return detailsRows(stmt);
}

function fill(rgb: string): CellStyle["fill"] {
  return { patternType: "solid", fgColor: { rgb } };
}

function styleFor(kind: RowKind, col: number, stripe: boolean, isNumber: boolean): CellStyle {
  const alignNum: CellStyle["alignment"] = {
    horizontal: isNumber ? "right" : "left",
    vertical: "center",
    wrapText: kind === "header" || kind === "identity" || kind === "recap" || kind === "note",
  };
  const base: CellStyle = {
    font: { name: FONT, sz: 11, color: { rgb: INK } },
    alignment: alignNum,
  };

  if (kind === "title") {
    return { font: { name: FONT, sz: 16, bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "left", vertical: "center" } };
  }
  if (kind === "subtitle") {
    return { font: { name: FONT, sz: 13, bold: true, color: { rgb: INK } }, alignment: { horizontal: "left", vertical: "center" } };
  }
  if (kind === "meta") {
    return { font: { name: FONT, sz: 11, italic: true, color: { rgb: MUTED } }, alignment: { horizontal: "left", vertical: "center" } };
  }
  if (kind === "header") {
    return {
      font: { name: FONT, sz: 11, bold: true, color: { rgb: WHITE } },
      fill: fill(NAVY),
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border,
    };
  }
  if (kind === "sector") {
    return {
      font: { name: FONT, sz: 11, bold: true, color: { rgb: "155EEF" } },
      fill: fill(SECTOR_BG),
      alignment: { horizontal: "left", vertical: "center" },
      border,
    };
  }
  if (kind === "total") {
    return {
      font: { name: FONT, sz: 11, bold: true, color: { rgb: WHITE } },
      fill: fill(NAVY),
      alignment: { horizontal: isNumber ? "right" : "left", vertical: "center" },
      border,
      numFmt: isNumber ? NUM_FMT : undefined,
    };
  }
  if (kind === "identity" || kind === "recap") {
    const label = col % 2 === 0;
    return {
      font: { name: FONT, sz: 11, bold: label, color: { rgb: label ? NAVY : INK } },
      fill: fill(label ? LABEL_BG : WHITE),
      alignment: { horizontal: label || !isNumber ? "left" : "right", vertical: "center", wrapText: true },
      border,
      numFmt: isNumber ? NUM_FMT : undefined,
    };
  }
  if (kind === "note") {
    return { font: { name: FONT, sz: 10, italic: true, color: { rgb: MUTED } }, alignment: { wrapText: true, vertical: "center", horizontal: "left" } };
  }
  if (kind === "data") {
    return {
      font: { name: FONT, sz: 11, color: { rgb: INK } },
      fill: fill(stripe ? STRIPE_BG : WHITE),
      alignment: alignNum,
      border,
      numFmt: isNumber ? NUM_FMT : undefined,
    };
  }
  return base;
}

function colWidths(rows: StyledRow[], mins: number[], colCount: number) {
  const widths = Array.from({ length: colCount }, (_, i) => mins[i] ?? 14);
  for (const row of rows) {
    row.cells.forEach((value, i) => {
      const text = value == null || value === "" ? "" : String(value);
      widths[i] = Math.min(48, Math.max(widths[i], text.length + 4));
    });
  }
  widths[0] = Math.max(widths[0], 36);
  return widths.map((wch) => ({ wch }));
}

function paintSheet(rows: StyledRow[], mins: number[]) {
  const aoa = rows.map((row) => row.cells);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const colCount = Math.max(mins.length, ...rows.map((row) => row.cells.length), 1);
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];

  rows.forEach((row, r) => {
    if (row.kind === "title" || row.kind === "subtitle" || row.kind === "meta" || row.kind === "sector") {
      merges.push({ s: { r, c: 0 }, e: { r, c: colCount - 1 } });
    }
    for (let c = 0; c < colCount; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) {
        if (row.kind === "header" || row.kind === "sector" || row.kind === "total" || row.kind === "data") {
          ws[addr] = { t: "s", v: "" };
        } else {
          continue;
        }
      }
      const isNumber = typeof ws[addr].v === "number";
      ws[addr].s = styleFor(row.kind, c, !!row.stripe, isNumber);
      if (isNumber) ws[addr].z = NUM_FMT;
    }
  });

  ws["!cols"] = colWidths(rows, mins, colCount);
  ws["!rows"] = rows.map((row) => {
    if (row.kind === "title") return { hpt: 24 };
    if (row.kind === "header") return { hpt: 32 };
    if (row.kind === "sector" || row.kind === "total") return { hpt: 22 };
    return { hpt: 18 };
  });
  ws["!merges"] = merges;
  const headerRow = rows.findIndex((row) => row.kind === "header");
  if (headerRow >= 0) {
    ws["!freeze"] = { xSplit: 0, ySplit: headerRow + 1, topLeftCell: `A${headerRow + 2}`, activePane: "bottomLeft", state: "frozen" };
  }
  return ws;
}

export function statementWorkbook(stmt: ClientStatement): { filename: string; buffer: Buffer } {
  const { rows, mins } = layoutFor(stmt);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, paintSheet(rows, mins), sheetName(stmt));
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }));
  return { filename: filenameFor(stmt), buffer };
}
