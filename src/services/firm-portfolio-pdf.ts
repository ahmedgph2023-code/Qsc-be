/**
 * Total Investment Clients Portfolio PDF (client brief, 19 Sep 2026): company
 * logo, the as-of header, the same columns as the Excel export, prices at three
 * decimals. Landscape A4 — the tables are wider than portrait can hold.
 */
import PDFDocument from "pdfkit";
import { resolveClientReportLogoPath } from "./client-report-pdf.js";
import {
  firmHoldersHeaderLines,
  firmPortfolioHeaderLines,
  type FirmPortfolioDrilldown,
  type FirmPortfolioHolder,
  type FirmPortfolioResult,
  type FirmPortfolioStock,
} from "./ext-firm-portfolio.js";

const NAVY = "#17356d";
const MUTED = "#657491";
const GRID = "#dce5f2";
const HEAD_BG = "#f8faff";
const TOTAL_BG = "#eef3ff";
const COMPANY_NAME = "Qatar Securities Co. (P.Q.S.C)";

const PAGE_MARGIN = 28;
/** A4 landscape width in points; every table must fit between the margins. */
export const FIRM_PDF_PRINTABLE_WIDTH = 841.89 - PAGE_MARGIN * 2;

const money = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const qty = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 0 }));
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

type Col<Row> = { label: string; w: number; align: "left" | "right" | "center"; value: (r: Row) => string };

export const FIRM_STOCK_COLUMNS: Col<FirmPortfolioStock>[] = [
  { label: "Ticker", w: 42, align: "left", value: (r) => r.ticker },
  { label: "Company", w: 110, align: "left", value: (r) => r.companyName },
  { label: "Sector", w: 82, align: "left", value: (r) => r.sector || "Unclassified" },
  { label: "Clients", w: 40, align: "right", value: (r) => qty(r.clientCount) },
  { label: "Quantity", w: 58, align: "right", value: (r) => qty(r.totalQuantity) },
  { label: "Cost", w: 70, align: "right", value: (r) => money(r.totalCost) },
  { label: "Mkt Price", w: 52, align: "right", value: (r) => price(r.marketPrice) },
  { label: "Market Value", w: 72, align: "right", value: (r) => money(r.marketValue) },
  { label: "Stock %", w: 44, align: "right", value: (r) => pct(r.stockPct) },
  { label: "Sector %", w: 44, align: "right", value: (r) => pct(r.sectorPct) },
  { label: "Unrealized", w: 64, align: "right", value: (r) => money(r.unrealizedPl) },
  { label: "Return %", w: 44, align: "right", value: (r) => pct(r.returnPct) },
  { label: "Realized", w: 60, align: "right", value: (r) => money(r.realizedPl) },
];

export const FIRM_HOLDER_COLUMNS: Col<FirmPortfolioHolder>[] = [
  { label: "Client ID", w: 60, align: "left", value: (r) => String(r.clientId) },
  { label: "Client Name", w: 120, align: "left", value: (r) => r.clientName },
  { label: "NIN", w: 52, align: "left", value: (r) => r.nin || "—" },
  { label: "Quantity", w: 64, align: "right", value: (r) => qty(r.quantity) },
  { label: "Cost", w: 72, align: "right", value: (r) => money(r.cost) },
  { label: "Cost Price", w: 54, align: "right", value: (r) => price(r.costPrice) },
  { label: "Mkt Price", w: 54, align: "right", value: (r) => price(r.marketPrice) },
  { label: "Market Value", w: 78, align: "right", value: (r) => money(r.marketValue) },
  { label: "Share %", w: 46, align: "right", value: (r) => pct(r.holderPct) },
  { label: "Unrealized", w: 72, align: "right", value: (r) => money(r.unrealizedPl) },
  { label: "Return %", w: 44, align: "right", value: (r) => pct(r.returnPct) },
  { label: "Realized", w: 66, align: "right", value: (r) => money(r.realizedPl) },
];

const tableWidth = <Row,>(columns: Col<Row>[]) => columns.reduce((s, c) => s + c.w, 0);

function drawHeaderBand(
  doc: PDFKit.PDFDocument,
  title: string,
  lines: Array<{ label: string; value: string }>,
): void {
  const left = doc.page.margins.left;
  const top = doc.y;
  const logoPath = resolveClientReportLogoPath();
  let textX = left;

  if (logoPath) {
    try {
      doc.image(logoPath, left, top, { fit: [110, 40] });
      textX = left + 124;
    } catch {
      // Text-only brand if the image cannot be decoded.
    }
  }

  doc.fontSize(13).fillColor(NAVY).text(COMPANY_NAME, textX, top, { lineBreak: false });
  doc.fontSize(11).fillColor(NAVY).text(title, textX, top + 17, { lineBreak: false });
  doc.y = top + 46;

  doc.fontSize(8).fillColor(MUTED);
  for (const line of lines) {
    doc.text(`${line.label}: ${line.value}`, left, doc.y, { lineBreak: false });
    doc.y += 11;
  }
  doc.y += 6;
}

function drawTableHeader<Row>(doc: PDFKit.PDFDocument, columns: Col<Row>[]): void {
  const left = doc.page.margins.left;
  const y = doc.y;
  const width = tableWidth(columns);
  doc.rect(left, y, width, 16).fill(HEAD_BG);
  doc.strokeColor(GRID).rect(left, y, width, 16).stroke();
  let x = left;
  doc.fontSize(6.5).fillColor(MUTED);
  for (const col of columns) {
    doc.text(col.label, x + 2, y + 5, { width: col.w - 4, align: col.align, lineBreak: false });
    x += col.w;
  }
  doc.y = y + 18;
}

function drawRow<Row>(
  doc: PDFKit.PDFDocument,
  columns: Col<Row>[],
  cells: string[],
  opts: { bold?: boolean } = {},
): void {
  const left = doc.page.margins.left;
  const y = doc.y;
  if (opts.bold) doc.rect(left, y - 2, tableWidth(columns), 14).fill(TOTAL_BG);
  let x = left;
  doc.fontSize(6.5).fillColor(NAVY).font(opts.bold ? "Helvetica-Bold" : "Helvetica");
  for (const [i, col] of columns.entries()) {
    doc.text(cells[i] ?? "", x + 2, y + 2, { width: col.w - 4, align: col.align, lineBreak: false });
    x += col.w;
  }
  doc.font("Helvetica");
  doc.y = y + 12;
}

function ensureRoom<Row>(doc: PDFKit.PDFDocument, columns: Col<Row>[], need = 20): void {
  if (doc.y + need > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    drawTableHeader(doc, columns);
  }
}

function newDoc(title: string, subject: string): PDFKit.PDFDocument {
  return new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: PAGE_MARGIN,
    info: { Title: title, Author: "QSC IPMS", Subject: subject },
  });
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function drawFootnote(doc: PDFKit.PDFDocument): void {
  doc.moveDown(1);
  doc.fontSize(7).fillColor("#9aa6ba").text(
    `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} AST — QSC IPMS.`,
    doc.page.margins.left,
    doc.y,
  );
}

/** PDF export for the firm stock list, followed by the sector rollup. */
export async function firmPortfolioPdf(
  report: FirmPortfolioResult,
): Promise<{ filename: string; buffer: Buffer }> {
  const doc = newDoc("Total Investment Clients Portfolio", `Firm portfolio as of ${report.asOf}`);
  const done = collect(doc);
  const columns = FIRM_STOCK_COLUMNS;

  drawHeaderBand(doc, "Total Investment Clients Portfolio", firmPortfolioHeaderLines(report));
  drawTableHeader(doc, columns);

  for (const stock of report.stocks) {
    ensureRoom(doc, columns);
    drawRow(doc, columns, columns.map((c) => c.value(stock)));
  }

  ensureRoom(doc, columns, 24);
  const totals = new Array(columns.length).fill("");
  totals[0] = "TOTAL";
  totals[4] = qty(report.totals.totalQuantity);
  totals[5] = money(report.totals.totalCost);
  totals[7] = money(report.totals.marketValue);
  totals[8] = report.totals.marketValue > 0 ? "100.00%" : "—";
  totals[10] = money(report.totals.unrealizedPl);
  totals[12] = money(report.totals.realizedPl);
  drawRow(doc, columns, totals, { bold: true });

  if (report.sectors.length) {
    doc.moveDown(1.5);
    doc.fontSize(10).fillColor(NAVY).text("Portfolio by Sector", doc.page.margins.left, doc.y);
    doc.y += 6;
    const sectorColumns: Col<(typeof report.sectors)[number]>[] = [
      { label: "Sector", w: 150, align: "left", value: (r) => r.sector },
      { label: "Stocks", w: 46, align: "right", value: (r) => qty(r.stockCount) },
      { label: "Cost", w: 90, align: "right", value: (r) => money(r.totalCost) },
      { label: "Market Value", w: 90, align: "right", value: (r) => money(r.marketValue) },
      { label: "Sector %", w: 56, align: "right", value: (r) => pct(r.sectorPct) },
      { label: "Unrealized", w: 90, align: "right", value: (r) => money(r.unrealizedPl) },
      { label: "Realized", w: 90, align: "right", value: (r) => money(r.realizedPl) },
    ];
    drawTableHeader(doc, sectorColumns);
    for (const sector of report.sectors) {
      ensureRoom(doc, sectorColumns);
      drawRow(doc, sectorColumns, sectorColumns.map((c) => c.value(sector)));
    }
  }

  drawFootnote(doc);
  doc.end();
  return { filename: `FirmPortfolio_${report.asOf}.pdf`, buffer: await done };
}

/** PDF export for the holders of one stock (the drill-down table). */
export async function firmHoldersPdf(
  drill: FirmPortfolioDrilldown,
): Promise<{ filename: string; buffer: Buffer }> {
  const doc = newDoc("Stock Holders — Clients Details", `${drill.ticker} holders as of ${drill.asOf}`);
  const done = collect(doc);
  const columns = FIRM_HOLDER_COLUMNS;

  drawHeaderBand(doc, "Stock Holders — Clients Details", firmHoldersHeaderLines(drill));
  drawTableHeader(doc, columns);

  for (const holder of drill.holders) {
    ensureRoom(doc, columns);
    drawRow(doc, columns, columns.map((c) => c.value(holder)));
  }

  ensureRoom(doc, columns, 24);
  const totals = new Array(columns.length).fill("");
  totals[0] = "TOTAL";
  totals[3] = qty(drill.totals.totalQuantity);
  totals[4] = money(drill.totals.totalCost);
  totals[7] = money(drill.totals.marketValue);
  totals[8] = drill.totals.marketValue > 0 ? "100.00%" : "—";
  totals[9] = money(drill.totals.unrealizedPl);
  totals[11] = money(drill.totals.realizedPl);
  drawRow(doc, columns, totals, { bold: true });

  drawFootnote(doc);
  doc.end();
  return { filename: `StockHolders_${drill.ticker}_${drill.asOf}.pdf`, buffer: await done };
}
