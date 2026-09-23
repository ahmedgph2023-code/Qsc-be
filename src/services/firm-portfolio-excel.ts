/**
 * Total Investment Clients Portfolio Excel (client brief, 19 Sep 2026): company
 * logo, the as-of header, sector and weight columns, prices at three decimals.
 * Two exports — the firm stock list (with a sector sheet) and the holders of a
 * single stock.
 *
 * Written with ExcelJS because the logo has to be a real embedded image.
 */
import ExcelJS from "exceljs";
import { resolveClientReportLogoPath } from "./client-report-pdf.js";
import {
  firmHoldersHeaderLines,
  firmPortfolioHeaderLines,
  type FirmPortfolioDrilldown,
  type FirmPortfolioHolder,
  type FirmPortfolioResult,
  type FirmPortfolioSector,
  type FirmPortfolioStock,
} from "./ext-firm-portfolio.js";

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
const PCT = "#,##0.00\\%";

const thin = { style: "thin" as const, color: { argb: GRID } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

type Align = "left" | "right" | "center";

type Column<Row> = {
  header: string;
  width: number;
  align: Align;
  numFmt?: string;
  value: (row: Row) => string | number;
  /** Printed in the TOTAL row; omit for columns that must not be summed. */
  total?: () => string | number;
};

const dash = (n: number | null) => (n == null ? "—" : n);

const STOCK_COLUMNS = (report: FirmPortfolioResult): Column<FirmPortfolioStock>[] => [
  { header: "Ticker", width: 12, align: "left", value: (r) => r.ticker },
  { header: "Company", width: 30, align: "left", value: (r) => r.companyName },
  { header: "Sector", width: 22, align: "left", value: (r) => r.sector || "Unclassified" },
  { header: "Clients", width: 9, align: "right", numFmt: QTY, value: (r) => r.clientCount },
  {
    header: "Quantity",
    width: 14,
    align: "right",
    numFmt: QTY,
    value: (r) => r.totalQuantity,
    total: () => report.totals.totalQuantity,
  },
  {
    header: "Cost",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => r.totalCost,
    total: () => report.totals.totalCost,
  },
  { header: "Market Price", width: 13, align: "right", numFmt: PRICE, value: (r) => dash(r.marketPrice) },
  {
    header: "Market Value",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => dash(r.marketValue),
    total: () => report.totals.marketValue,
  },
  {
    header: "Stock %",
    width: 10,
    align: "right",
    numFmt: PCT,
    value: (r) => dash(r.stockPct),
    total: () => (report.totals.marketValue > 0 ? 100 : "—"),
  },
  { header: "Sector %", width: 10, align: "right", numFmt: PCT, value: (r) => dash(r.sectorPct) },
  {
    header: "Unrealized P/L",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => dash(r.unrealizedPl),
    total: () => report.totals.unrealizedPl,
  },
  { header: "Return %", width: 10, align: "right", numFmt: PCT, value: (r) => dash(r.returnPct) },
  {
    header: "Realized P/L",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => r.realizedPl,
    total: () => report.totals.realizedPl,
  },
];

const SECTOR_COLUMNS: Column<FirmPortfolioSector>[] = [
  { header: "Sector", width: 26, align: "left", value: (r) => r.sector },
  { header: "Stocks", width: 9, align: "right", numFmt: QTY, value: (r) => r.stockCount },
  { header: "Cost", width: 16, align: "right", numFmt: NUM, value: (r) => r.totalCost },
  { header: "Market Value", width: 16, align: "right", numFmt: NUM, value: (r) => dash(r.marketValue) },
  { header: "Sector %", width: 10, align: "right", numFmt: PCT, value: (r) => dash(r.sectorPct) },
  { header: "Unrealized P/L", width: 16, align: "right", numFmt: NUM, value: (r) => dash(r.unrealizedPl) },
  { header: "Realized P/L", width: 16, align: "right", numFmt: NUM, value: (r) => r.realizedPl },
];

const HOLDER_COLUMNS = (drill: FirmPortfolioDrilldown): Column<FirmPortfolioHolder>[] => [
  { header: "Client ID", width: 13, align: "left", value: (r) => r.clientId },
  { header: "Client Name", width: 32, align: "left", value: (r) => r.clientName },
  { header: "NIN", width: 12, align: "left", value: (r) => r.nin },
  {
    header: "Quantity",
    width: 14,
    align: "right",
    numFmt: QTY,
    value: (r) => r.quantity,
    total: () => drill.totals.totalQuantity,
  },
  {
    header: "Cost",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => r.cost,
    total: () => drill.totals.totalCost,
  },
  { header: "Cost Price", width: 13, align: "right", numFmt: PRICE, value: (r) => r.costPrice },
  { header: "Market Price", width: 13, align: "right", numFmt: PRICE, value: (r) => dash(r.marketPrice) },
  {
    header: "Market Value",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => dash(r.marketValue),
    total: () => drill.totals.marketValue,
  },
  {
    header: "Share of Stock %",
    width: 15,
    align: "right",
    numFmt: PCT,
    value: (r) => dash(r.holderPct),
    total: () => (drill.totals.marketValue > 0 ? 100 : "—"),
  },
  {
    header: "Unrealized P/L",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => dash(r.unrealizedPl),
    total: () => drill.totals.unrealizedPl,
  },
  { header: "Return %", width: 10, align: "right", numFmt: PCT, value: (r) => dash(r.returnPct) },
  {
    header: "Realized P/L",
    width: 16,
    align: "right",
    numFmt: NUM,
    value: (r) => r.realizedPl,
    total: () => drill.totals.realizedPl,
  },
];

function addBrandHeader(
  ws: ExcelJS.Worksheet,
  workbook: ExcelJS.Workbook,
  title: string,
  lines: Array<{ label: string; value: string }>,
): void {
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

  const heading = ws.addRow([title]);
  heading.font = { name: FONT, size: 12, bold: true, color: { argb: TITLE_NAVY } };
  heading.height = 20;

  for (const line of lines) {
    const row = ws.addRow([`${line.label}: ${line.value}`]);
    row.font = { name: FONT, size: 10 };
  }
  ws.addRow([]);
}

function writeTable<Row>(ws: ExcelJS.Worksheet, columns: Column<Row>[], rows: Row[], withTotals: boolean): void {
  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.height = 26;
  headerRow.eachCell((cell, col) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
    ws.getColumn(col).width = columns[col - 1]!.width;
  });

  rows.forEach((row, index) => {
    const added = ws.addRow(columns.map((c) => c.value(row)));
    added.eachCell((cell, col) => {
      const column = columns[col - 1]!;
      cell.font = { name: FONT, size: 10 };
      cell.alignment = { horizontal: column.align, vertical: "middle" };
      cell.border = BORDER;
      if (column.numFmt) cell.numFmt = column.numFmt;
      if (index % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STRIPE } };
    });
  });

  if (!withTotals) return;
  const totalsRow = ws.addRow(columns.map((c, i) => (i === 0 ? "TOTAL" : c.total ? c.total() : "")));
  totalsRow.eachCell((cell, col) => {
    const column = columns[col - 1]!;
    cell.font = { name: FONT, size: 10, bold: true };
    cell.alignment = { horizontal: column.align, vertical: "middle" };
    cell.border = BORDER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
    if (column.numFmt) cell.numFmt = column.numFmt;
  });
}

function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "QSC IPMS";
  return workbook;
}

const LANDSCAPE = {
  views: [{ state: "frozen" as const, ySplit: 0 }],
  pageSetup: { orientation: "landscape" as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
};

/** Excel export for the firm stock list, plus a sector rollup sheet. */
export async function firmPortfolioWorkbook(
  report: FirmPortfolioResult,
): Promise<{ filename: string; buffer: Buffer }> {
  const workbook = newWorkbook();

  const stocksSheet = workbook.addWorksheet("Portfolio", LANDSCAPE);
  addBrandHeader(stocksSheet, workbook, "Total Investment Clients Portfolio", firmPortfolioHeaderLines(report));
  writeTable(stocksSheet, STOCK_COLUMNS(report), report.stocks, true);

  const sectorsSheet = workbook.addWorksheet("Sectors", LANDSCAPE);
  addBrandHeader(sectorsSheet, workbook, "Portfolio by Sector", firmPortfolioHeaderLines(report));
  writeTable(sectorsSheet, SECTOR_COLUMNS, report.sectors, false);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename: `FirmPortfolio_${report.asOf}.xlsx`, buffer };
}

/** Excel export for the holders of one stock (the drill-down table). */
export async function firmHoldersWorkbook(
  drill: FirmPortfolioDrilldown,
): Promise<{ filename: string; buffer: Buffer }> {
  const workbook = newWorkbook();
  const ws = workbook.addWorksheet("Holders", LANDSCAPE);
  addBrandHeader(ws, workbook, "Stock Holders — Clients Details", firmHoldersHeaderLines(drill));
  writeTable(ws, HOLDER_COLUMNS(drill), drill.holders, true);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename: `StockHolders_${drill.ticker}_${drill.asOf}.xlsx`, buffer };
}
