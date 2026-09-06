import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { ClientReportPayload } from "./client-report-engine.js";
import type { ClientReportSection } from "../db/schema/client-reports.js";

export type ClientReportPdfFile = {
  filename: string;
  contentType: "application/pdf";
  buffer: Buffer;
};

/** Same brand file statements use in the dashboard (`public/logo.png`). */
export function resolveClientReportLogoPath(): string | null {
  const override = process.env.CLIENT_REPORT_LOGO_PATH?.trim();
  if (override && fs.existsSync(override)) return override;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../frontend/artifacts/portfolio-dashboard/public/small-logo.png"),
    path.resolve(here, "../../../frontend/artifacts/portfolio-dashboard/public/logo.png"),
    path.resolve(here, "../../../frontend/artifacts/portfolio-dashboard/public/logo-mark.png"),
    path.resolve(process.cwd(), "../frontend/artifacts/portfolio-dashboard/public/small-logo.png"),
    path.resolve(process.cwd(), "../frontend/artifacts/portfolio-dashboard/public/logo.png"),
    path.resolve(process.cwd(), "assets/qsc-logo.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function drawBrandHeader(doc: PDFKit.PDFDocument) {
  const left = doc.page.margins.left;
  const top = doc.y;
  const logoPath = resolveClientReportLogoPath();

  if (logoPath) {
    // Keep height modest so header stays one visual band.
    const logoH = 42;
    const logoW = 120;
    try {
      doc.image(logoPath, left, top, { fit: [logoW, logoH] });
      doc.fontSize(10).fillColor("#657491").text(
        "Client Portfolio Report — IPMS",
        left + logoW + 12,
        top + 14,
        { width: doc.page.width - doc.page.margins.right - left - logoW - 12 },
      );
      doc.y = top + logoH + 10;
      return;
    } catch {
      // Fall through to text-only brand if image decode fails.
    }
  }

  doc.fontSize(16).fillColor("#17356d").text("Qatar Co. for Securities", { align: "left" });
  doc.fontSize(11).fillColor("#657491").text("Client Portfolio Report — IPMS");
}

function money(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function text(v: unknown, fallback = "—"): string {
  if (v == null || v === "") return fallback;
  return String(v);
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
}

function drawKv(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, w: number) {
  doc.fontSize(8).fillColor("#657491").text(label, x, y, { width: w });
  doc.fontSize(10).fillColor("#17356d").text(value, x, y + 12, { width: w });
}

function ensureSpace(doc: PDFKit.PDFDocument, need = 80) {
  if (doc.y + need > doc.page.height - 50) {
    doc.addPage();
  }
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fontSize(12).fillColor("#17356d").text(title, { underline: false });
  doc.moveDown(0.3);
  doc.strokeColor("#dce5f2").moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.4);
}

function tableHeader(doc: PDFKit.PDFDocument, cols: Array<{ label: string; w: number; align?: "left" | "right" }>) {
  ensureSpace(doc, 28);
  const startX = doc.page.margins.left;
  let x = startX;
  const y = doc.y;
  doc.rect(startX, y, cols.reduce((s, c) => s + c.w, 0), 18).fill("#f8faff");
  doc.fillColor("#657491").fontSize(7);
  for (const col of cols) {
    doc.text(col.label, x + 2, y + 5, { width: col.w - 4, align: col.align ?? "left" });
    x += col.w;
  }
  doc.y = y + 20;
  doc.fillColor("#17356d");
}

function tableRow(
  doc: PDFKit.PDFDocument,
  cols: Array<{ value: string; w: number; align?: "left" | "right" }>,
) {
  ensureSpace(doc, 16);
  const startX = doc.page.margins.left;
  let x = startX;
  const y = doc.y;
  doc.fontSize(7).fillColor("#17356d");
  for (const col of cols) {
    doc.text(col.value, x + 2, y, { width: col.w - 4, align: col.align ?? "left", lineBreak: false });
    x += col.w;
  }
  doc.y = y + 12;
}

function renderPerformance(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No performance data for this period.");
    return;
  }
  const row = value as Record<string, unknown>;
  const items = [
    ["As of", text(row.asOf)],
    ["NAV", money(row.nav)],
    ["Market value", money(row.marketValue)],
    ["Cost", money(row.cost)],
    ["Cash", money(row.cash)],
    ["Net P&L", money(row.netPl)],
  ];
  let col = 0;
  const startY = doc.y;
  for (const [label, val] of items) {
    const x = doc.page.margins.left + (col % 3) * 170;
    const y = startY + Math.floor(col / 3) * 36;
    drawKv(doc, label, val, x, y, 160);
    col += 1;
  }
  doc.y = startY + Math.ceil(items.length / 3) * 36;
}

function renderBalance(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No balance snapshot for this date.");
    return;
  }
  const row = value as Record<string, unknown>;
  renderPerformance(doc, {
    asOf: row.asOf ?? row.snapshotDate,
    nav: row.navValue ?? row.portfolioValue,
    cash: row.cashBalance,
    marketValue: row.portfolioValue,
    cost: row.costValue,
    netPl: row.pl,
  });
  doc.fontSize(9).fillColor("#657491").text(`Status: ${text(row.status ?? row.matchStatus)}`);
}

function renderTransactions(doc: PDFKit.PDFDocument, value: unknown) {
  const lines = Array.isArray(value) ? value : [];
  if (!lines.length) {
    doc.fontSize(9).fillColor("#657491").text("No transactions in this period.");
    return;
  }
  const cols = [
    { label: "Date", w: 70 },
    { label: "Type", w: 55 },
    { label: "Description", w: 210 },
    { label: "Debit", w: 70, align: "right" as const },
    { label: "Credit", w: 70, align: "right" as const },
    { label: "Balance", w: 70, align: "right" as const },
  ];
  tableHeader(doc, cols);
  for (const raw of lines.slice(0, 80)) {
    const l = raw as Record<string, unknown>;
    tableRow(doc, [
      { value: text(l.postDate ?? l.date), w: 70 },
      { value: text(l.transType ?? l.type), w: 55 },
      { value: text(l.description ?? l.remarks).slice(0, 42), w: 210 },
      { value: money(l.debit), w: 70, align: "right" },
      { value: money(l.credit), w: 70, align: "right" },
      { value: money(l.balance), w: 70, align: "right" },
    ]);
  }
  if (lines.length > 80) {
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor("#657491").text(`… ${lines.length - 80} more rows omitted`);
  }
}

function renderPortfolio(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No portfolio statement.");
    return;
  }
  const stmt = value as {
    grandTotalCost?: number;
    grandTotalMarketValue?: number | null;
    footer?: Record<string, unknown>;
    sectors?: Array<{ sectorName?: string; lines?: Array<Record<string, unknown>> }>;
  };
  doc.fontSize(9).fillColor("#17356d")
    .text(`Cost: ${money(stmt.grandTotalCost)}   Market: ${money(stmt.grandTotalMarketValue)}   NAV: ${money(stmt.footer?.netAssetValue)}   P&L: ${money(stmt.footer?.netProfitLoss)}`);
  doc.moveDown(0.4);
  const cols = [
    { label: "Ticker", w: 55 },
    { label: "Name", w: 160 },
    { label: "Qty", w: 55, align: "right" as const },
    { label: "Cost", w: 75, align: "right" as const },
    { label: "Mkt", w: 75, align: "right" as const },
    { label: "P&L", w: 75, align: "right" as const },
  ];
  tableHeader(doc, cols);
  let rows = 0;
  for (const sector of stmt.sectors ?? []) {
    for (const line of sector.lines ?? []) {
      if (rows >= 100) break;
      tableRow(doc, [
        { value: text(line.ticker), w: 55 },
        { value: text(line.companyName).slice(0, 28), w: 160 },
        { value: text(line.quantity), w: 55, align: "right" },
        { value: money(line.costValue), w: 75, align: "right" },
        { value: money(line.marketValue), w: 75, align: "right" },
        { value: money(line.displayedProfit ?? line.unrealizedGross), w: 75, align: "right" },
      ]);
      rows += 1;
    }
  }
  if (!rows) doc.fontSize(9).fillColor("#657491").text("No holdings lines.");
}

function renderAccount(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No account statement.");
    return;
  }
  const stmt = value as Record<string, unknown>;
  doc.fontSize(9).fillColor("#17356d")
    .text(`Opening: ${money(stmt.openingBalance)}   Closing: ${money(stmt.closingBalance)}   Lines: ${text(stmt.transactionCount)}`);
  doc.moveDown(0.3);
  renderTransactions(doc, stmt.lines);
}

function renderRealizedSummary(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No realized summary.");
    return;
  }
  const stmt = value as {
    tradingProfitTotal?: number;
    footer?: Record<string, unknown>;
    lines?: Array<Record<string, unknown>>;
  };
  doc.fontSize(9).fillColor("#17356d")
    .text(`Trading profit total: ${money(stmt.tradingProfitTotal)}   Net P&L: ${money(stmt.footer?.netProfitLoss)}`);
  doc.moveDown(0.3);
  const cols = [
    { label: "Ticker", w: 60 },
    { label: "Company", w: 220 },
    { label: "Trading P&L", w: 90, align: "right" as const },
    { label: "Total P&L", w: 90, align: "right" as const },
  ];
  tableHeader(doc, cols);
  for (const line of (stmt.lines ?? []).slice(0, 60)) {
    tableRow(doc, [
      { value: text(line.ticker), w: 60 },
      { value: text(line.companyName).slice(0, 40), w: 220 },
      { value: money(line.tradingProfit), w: 90, align: "right" },
      { value: money(line.totalProfit), w: 90, align: "right" },
    ]);
  }
}

function renderRealizedDetails(doc: PDFKit.PDFDocument, value: unknown) {
  if (!value || typeof value !== "object") {
    doc.fontSize(9).fillColor("#657491").text("No realized details.");
    return;
  }
  const stmt = value as { lines?: Array<Record<string, unknown>>; blotter?: Array<Record<string, unknown>> };
  const lines = stmt.lines ?? stmt.blotter ?? [];
  if (!lines.length) {
    doc.fontSize(9).fillColor("#657491").text("No realized detail rows.");
    return;
  }
  const cols = [
    { label: "Date", w: 70 },
    { label: "Ticker", w: 55 },
    { label: "Side", w: 45 },
    { label: "Qty", w: 55, align: "right" as const },
    { label: "Price", w: 70, align: "right" as const },
    { label: "P&L", w: 70, align: "right" as const },
  ];
  tableHeader(doc, cols);
  for (const line of lines.slice(0, 80)) {
    tableRow(doc, [
      { value: text(line.tradeDate ?? line.date ?? line.postDate), w: 70 },
      { value: text(line.ticker), w: 55 },
      { value: text(line.side ?? line.transType), w: 45 },
      { value: text(line.quantity ?? line.qty), w: 55, align: "right" },
      { value: money(line.price ?? line.sharePrice), w: 70, align: "right" },
      { value: money(line.realizedPl ?? line.profit), w: 70, align: "right" },
    ]);
  }
}

const SECTION_RENDERERS: Record<ClientReportSection, (doc: PDFKit.PDFDocument, value: unknown) => void> = {
  performance: renderPerformance,
  balance_snapshot: renderBalance,
  transactions: renderTransactions,
  portfolio_statement: renderPortfolio,
  account_statement: renderAccount,
  realized_summary: renderRealizedSummary,
  realized_details: renderRealizedDetails,
};

export function buildClientReportPdfFilename(payload: ClientReportPayload): string {
  const who = safeFilename(payload.client.name || String(payload.client.id));
  return `QSC-ClientReport-${who}-${payload.asOf}.pdf`;
}

/** Build a PDF buffer covering all selected report sections. */
export async function generateClientReportPdf(payload: ClientReportPayload): Promise<ClientReportPdfFile> {
  const filename = buildClientReportPdfFilename(payload);
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    info: {
      Title: payload.title,
      Author: "QSC IPMS",
      Subject: `Client report as of ${payload.asOf}`,
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawBrandHeader(doc);
  doc.moveDown(0.4);
  doc.fontSize(14).fillColor("#17356d").text(payload.title);
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor("#657491")
    .text(`Client: ${payload.client.name} (ID ${payload.client.id})`)
    .text(`As of: ${payload.asOf}   Period: ${payload.from} – ${payload.to}`)
    .text(`Generated: ${new Date(payload.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} AST`);

  const sectionKeys = Object.keys(payload.sections || {}) as ClientReportSection[];
  if (!sectionKeys.length) {
    doc.moveDown();
    doc.fontSize(10).fillColor("#657491").text("No report sections were selected for this send.");
  }

  for (const key of sectionKeys) {
    const label = payload.sectionLabels?.[key] ?? key;
    sectionTitle(doc, label);
    const renderer = SECTION_RENDERERS[key];
    if (renderer) renderer(doc, payload.sections[key]);
    else doc.fontSize(9).fillColor("#657491").text("Section content unavailable.");
  }

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor("#9aa6ba").text("Generated automatically by QSC IPMS. Figures follow server-side statement engines.");

  doc.end();
  const buffer = await done;
  return { filename, contentType: "application/pdf", buffer };
}
