/**
 * Invoice Report Excel (client brief, 19 Sep 2026): company logo, the selected
 * filters in the header, Invoice Sequence and Invoice Number as separate
 * columns, no Buy/Sell Qty or Account Type/ID, prices at three decimals.
 *
 * Written with ExcelJS because the logo has to be a real embedded image, which
 * the SheetJS-based writer used elsewhere cannot do.
 */
import ExcelJS from "exceljs";
import { formatDmY, invoiceFilterHeaderLines, type InvoiceReportResult } from "./ext-invoice-report.js";
import { resolveClientReportLogoPath } from "./client-report-pdf.js";

const COMPANY_NAME = "Qatar Securities Co. (P.Q.S.C)";
const NAVY = "FF0B1F4A";
const TITLE_NAVY = "FF17356D";
const WHITE = "FFFFFFFF";
const GRID = "FFD7E0EE";
const STRIPE = "FFF7F9FD";
const TOTAL_BG = "FFEEF3FF";
const FONT = "Calibri";
const NUM = "#,##0.00";
/** Prices carry three decimals. */
const PRICE = "#,##0.000";
const QTY = "#,##0";

type Align = "left" | "right" | "center";

type Column = {
  header: string;
  width: number;
  align: Align;
  numFmt?: string;
  value: (row: InvoiceReportResult["rows"][number]) => string | number;
  total?: (totals: InvoiceReportResult["totals"]) => number;
};

const COLUMNS: Column[] = [
  { header: "Invoice Sequence", width: 16, align: "left", value: (r) => r.invSequence ?? "" },
  { header: "Invoice Number", width: 15, align: "left", value: (r) => r.invNo ?? "" },
  { header: "Order Side", width: 11, align: "center", value: (r) => r.orderSide },
  { header: "NIN", width: 11, align: "left", value: (r) => r.nin },
  { header: "Account Name", width: 28, align: "left", value: (r) => r.accountName },
  { header: "Comp. Ticker", width: 13, align: "left", value: (r) => r.ticker },
  { header: "Company", width: 22, align: "left", value: (r) => r.company },
  { header: "Market", width: 22, align: "left", value: (r) => r.market },
  { header: "Trade Date", width: 13, align: "left", value: (r) => formatDmY(r.tradeDate) },
  { header: "Qty", width: 13, align: "right", numFmt: QTY, value: (r) => r.qty, total: (t) => t.qty },
  { header: "Price Avg.", width: 13, align: "right", numFmt: PRICE, value: (r) => r.priceAvg },
  { header: "Amount", width: 15, align: "right", numFmt: NUM, value: (r) => r.amount, total: (t) => t.amount },
  { header: "Total Comm.", width: 13, align: "right", numFmt: NUM, value: (r) => r.totalComm, total: (t) => t.totalComm },
  { header: "Office Comm.", width: 13, align: "right", numFmt: NUM, value: (r) => r.officeComm, total: (t) => t.officeComm },
  { header: "Market Comm.", width: 13, align: "right", numFmt: NUM, value: (r) => r.marketComm, total: (t) => t.marketComm },
  { header: "Net", width: 15, align: "right", numFmt: NUM, value: (r) => r.net, total: (t) => t.net },
];

const thin = { style: "thin" as const, color: { argb: GRID } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function addBrandHeader(ws: ExcelJS.Worksheet, workbook: ExcelJS.Workbook, report: InvoiceReportResult): void {
  const logoPath = resolveClientReportLogoPath();
  if (logoPath) {
    try {
      const imageId = workbook.addImage({ filename: logoPath, extension: "png" });
      // Floats above the first header rows; does not shift any cell.
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 52 } });
    } catch {
      // Text-only brand if the logo cannot be read.
    }
  }

  const company = ws.addRow([COMPANY_NAME]);
  company.font = { name: FONT, size: 14, bold: true, color: { argb: TITLE_NAVY } };
  company.height = 26;

  const title = ws.addRow(["Invoice Report"]);
  title.font = { name: FONT, size: 12, bold: true, color: { argb: TITLE_NAVY } };
  title.height = 20;

  for (const line of invoiceFilterHeaderLines(report)) {
    const row = ws.addRow([`${line.label}: ${line.value}`]);
    row.font = { name: FONT, size: 10 };
  }
  ws.addRow([]);
}

function styleDataCell(cell: ExcelJS.Cell, column: Column, stripe: boolean): void {
  cell.font = { name: FONT, size: 10 };
  cell.alignment = { horizontal: column.align, vertical: "middle" };
  cell.border = BORDER;
  if (column.numFmt) cell.numFmt = column.numFmt;
  if (stripe) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STRIPE } };
}

/** Excel export for the Invoice Report screen. */
export async function invoiceReportWorkbook(
  report: InvoiceReportResult,
): Promise<{ filename: string; buffer: Buffer }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "QSC IPMS";
  const ws = workbook.addWorksheet("Invoices", {
    views: [{ state: "frozen", ySplit: 0 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // Logo floats over the first rows, so keep them tall enough to clear it.
  addBrandHeader(ws, workbook, report);

  const headerRow = ws.addRow(COLUMNS.map((c) => c.header));
  headerRow.height = 26;
  headerRow.eachCell((cell, col) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
    ws.getColumn(col).width = COLUMNS[col - 1]!.width;
  });

  report.rows.forEach((row, index) => {
    const added = ws.addRow(COLUMNS.map((c) => c.value(row)));
    added.eachCell((cell, col) => styleDataCell(cell, COLUMNS[col - 1]!, index % 2 === 1));
  });

  const totalsRow = ws.addRow(
    COLUMNS.map((c, i) => (i === 0 ? "TOTAL" : c.total ? c.total(report.totals) : "")),
  );
  totalsRow.eachCell((cell, col) => {
    const column = COLUMNS[col - 1]!;
    cell.font = { name: FONT, size: 10, bold: true };
    cell.alignment = { horizontal: column.align, vertical: "middle" };
    cell.border = BORDER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
    if (column.numFmt) cell.numFmt = column.numFmt;
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename: `CustomerInvoices_${report.from}_${report.to}.xlsx`, buffer };
}
