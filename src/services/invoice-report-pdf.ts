/**
 * Invoice Report PDF (client brief, 19 Sep 2026): company logo, the selected
 * filters in the header, the same columns as the Excel export, prices at three
 * decimals. Landscape A4 — the table is wider than portrait can hold.
 */
import PDFDocument from "pdfkit";
import { formatDmY, invoiceFilterHeaderLines, type InvoiceReportResult } from "./ext-invoice-report.js";
import { resolveClientReportLogoPath } from "./client-report-pdf.js";

const NAVY = "#17356d";
const MUTED = "#657491";
const GRID = "#dce5f2";
const HEAD_BG = "#f8faff";
const TOTAL_BG = "#eef3ff";
const COMPANY_NAME = "Qatar Securities Co. (P.Q.S.C)";

type Col = { label: string; w: number; align: "left" | "right" | "center"; value: (r: InvoiceRow) => string };
type InvoiceRow = InvoiceReportResult["rows"][number];

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const COLUMNS: Col[] = [
  { label: "Inv Sequence", w: 52, align: "left", value: (r) => (r.invSequence == null ? "—" : String(r.invSequence)) },
  { label: "Inv Number", w: 52, align: "left", value: (r) => (r.invNo == null ? "—" : String(r.invNo)) },
  { label: "Side", w: 30, align: "center", value: (r) => r.orderSide },
  { label: "NIN", w: 38, align: "left", value: (r) => r.nin || "—" },
  { label: "Account Name", w: 88, align: "left", value: (r) => r.accountName },
  { label: "Ticker", w: 36, align: "left", value: (r) => r.ticker },
  { label: "Company", w: 70, align: "left", value: (r) => r.company },
  { label: "Trade Date", w: 52, align: "left", value: (r) => formatDmY(r.tradeDate) },
  { label: "Qty", w: 50, align: "right", value: (r) => qty(r.qty) },
  { label: "Price Avg.", w: 48, align: "right", value: (r) => price(r.priceAvg) },
  { label: "Amount", w: 60, align: "right", value: (r) => money(r.amount) },
  { label: "Total Comm.", w: 48, align: "right", value: (r) => money(r.totalComm) },
  { label: "Office Comm.", w: 48, align: "right", value: (r) => money(r.officeComm) },
  { label: "Market Comm.", w: 48, align: "right", value: (r) => money(r.marketComm) },
  { label: "Net", w: 58, align: "right", value: (r) => money(r.net) },
];

const PAGE_MARGIN = 28;
/** A4 landscape width in points; the table must fit between the margins. */
export const INVOICE_PDF_PRINTABLE_WIDTH = 841.89 - PAGE_MARGIN * 2;
export const INVOICE_PDF_TABLE_WIDTH = COLUMNS.reduce((s, c) => s + c.w, 0);

function drawHeaderBand(doc: PDFKit.PDFDocument, report: InvoiceReportResult): void {
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
  doc.fontSize(11).fillColor(NAVY).text("Invoice Report", textX, top + 17, { lineBreak: false });
  doc.y = top + 46;

  doc.fontSize(8).fillColor(MUTED);
  for (const line of invoiceFilterHeaderLines(report)) {
    doc.text(`${line.label}: ${line.value}`, left, doc.y, { lineBreak: false });
    doc.y += 11;
  }
  doc.y += 6;
}

function drawTableHeader(doc: PDFKit.PDFDocument): void {
  const left = doc.page.margins.left;
  const y = doc.y;
  const width = COLUMNS.reduce((s, c) => s + c.w, 0);
  doc.rect(left, y, width, 16).fill(HEAD_BG);
  doc.strokeColor(GRID).rect(left, y, width, 16).stroke();
  let x = left;
  doc.fontSize(6.5).fillColor(MUTED);
  for (const col of COLUMNS) {
    doc.text(col.label, x + 2, y + 5, { width: col.w - 4, align: col.align, lineBreak: false });
    x += col.w;
  }
  doc.y = y + 18;
}

function drawRow(doc: PDFKit.PDFDocument, cells: string[], opts: { bold?: boolean } = {}): void {
  const left = doc.page.margins.left;
  const y = doc.y;
  if (opts.bold) {
    doc.rect(left, y - 2, COLUMNS.reduce((s, c) => s + c.w, 0), 14).fill(TOTAL_BG);
  }
  let x = left;
  doc.fontSize(6.5).fillColor(NAVY).font(opts.bold ? "Helvetica-Bold" : "Helvetica");
  for (const [i, col] of COLUMNS.entries()) {
    doc.text(cells[i] ?? "", x + 2, y + 2, { width: col.w - 4, align: col.align, lineBreak: false });
    x += col.w;
  }
  doc.font("Helvetica");
  doc.y = y + 12;
}

function ensureRoom(doc: PDFKit.PDFDocument, need = 20): void {
  if (doc.y + need > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    drawTableHeader(doc);
  }
}

export async function invoiceReportPdf(
  report: InvoiceReportResult,
): Promise<{ filename: string; buffer: Buffer }> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: PAGE_MARGIN,
    info: { Title: "Invoice Report", Author: "QSC IPMS", Subject: `Invoices ${report.from} – ${report.to}` },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawHeaderBand(doc, report);
  drawTableHeader(doc);

  for (const row of report.rows) {
    ensureRoom(doc);
    drawRow(doc, COLUMNS.map((c) => c.value(row)));
  }

  ensureRoom(doc, 24);
  const totals = new Array(COLUMNS.length).fill("");
  totals[0] = "TOTAL";
  totals[8] = qty(report.totals.qty);
  totals[10] = money(report.totals.amount);
  totals[11] = money(report.totals.totalComm);
  totals[12] = money(report.totals.officeComm);
  totals[13] = money(report.totals.marketComm);
  totals[14] = money(report.totals.net);
  drawRow(doc, totals, { bold: true });

  doc.moveDown(1);
  doc.fontSize(7).fillColor("#9aa6ba").text(
    `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} AST — QSC IPMS.`,
    doc.page.margins.left,
    doc.y,
  );

  doc.end();
  const buffer = await done;
  return { filename: `CustomerInvoices_${report.from}_${report.to}.pdf`, buffer };
}
