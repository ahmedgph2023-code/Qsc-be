import XLSX from "xlsx-js-style";
import type { InvoiceReportResult } from "./ext-invoice-report.js";

const NAVY = "0B1F4A";
const WHITE = "FFFFFF";
const GRID = "D7E0EE";
const STRIPE = "F7F9FD";
const TOTAL_BG = "EEF3FF";
const FONT = "Calibri";
const NUM = "#,##0.00";
const QTY = "#,##0";

const thin = { style: "thin", color: { rgb: GRID } };
const border = { top: thin, bottom: thin, left: thin, right: thin };

function cell(v: string | number, style: Record<string, unknown> = {}) {
  return { v, t: typeof v === "number" ? "n" : "s", s: style };
}

function headerStyle() {
  return {
    font: { bold: true, color: { rgb: WHITE }, name: FONT, sz: 10 },
    fill: { patternType: "solid", fgColor: { rgb: NAVY } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border,
  };
}

function dataStyle(stripe: boolean, align: "left" | "right" | "center" = "left", numFmt?: string) {
  return {
    font: { name: FONT, sz: 10 },
    fill: stripe ? { patternType: "solid", fgColor: { rgb: STRIPE } } : undefined,
    alignment: { horizontal: align, vertical: "center" },
    border,
    ...(numFmt ? { numFmt } : {}),
  };
}

/** Excel export matching CAClientInvoice.xls column set (Customer Invoices). */
export function invoiceReportWorkbook(report: InvoiceReportResult): { filename: string; buffer: Buffer } {
  const headers = [
    "Inv Sequence",
    "Order Side",
    "Account ID",
    "NIN",
    "Account Name",
    "Account Type",
    "Comp. Ticker",
    "Company",
    "Market",
    "Trade Date",
    "Qty",
    "Price Avg.",
    "Amount",
    "Total Comm.",
    "Office Comm.",
    "Market Comm.",
    "Net",
  ];

  const aoa: Array<Array<string | number>> = [
    ["", "", "Customer Invoices"],
    ["", "", `From : ${formatDmY(report.from)}`, `To : ${formatDmY(report.to)}`],
    [],
    headers,
  ];

  for (const r of report.rows) {
    aoa.push([
      r.invSequence ?? "",
      r.orderSide,
      r.accountId,
      r.nin,
      r.accountName,
      r.accountType ?? "",
      r.ticker,
      r.company,
      r.market,
      formatDmY(r.tradeDate),
      r.qty,
      r.priceAvg,
      r.amount,
      r.totalComm,
      r.officeComm,
      r.marketComm,
      r.net,
    ]);
  }

  aoa.push([
    "TOTAL",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    report.totals.qty,
    "",
    report.totals.amount,
    report.totals.totalComm,
    report.totals.officeComm,
    report.totals.marketComm,
    report.totals.net,
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const existing = ws[addr];
      if (!existing) continue;
      if (R === 0) {
        ws[addr] = cell(existing.v, {
          font: { bold: true, name: FONT, sz: 14, color: { rgb: NAVY } },
          alignment: { horizontal: "left" },
        });
        continue;
      }
      if (R === 1) {
        ws[addr] = cell(existing.v, { font: { name: FONT, sz: 10 }, alignment: { horizontal: "left" } });
        continue;
      }
      if (R === 3) {
        ws[addr] = cell(existing.v, headerStyle());
        continue;
      }
      const isTotal = R === range.e.r;
      const stripe = !isTotal && (R - 4) % 2 === 1;
      const moneyCols = new Set([11, 12, 13, 14, 15, 16]);
      const qtyCols = new Set([10]);
      const align = moneyCols.has(C) || qtyCols.has(C) || C === 2 ? "right" : C === 1 ? "center" : "left";
      const numFmt = moneyCols.has(C) ? NUM : qtyCols.has(C) ? QTY : undefined;
      const base = dataStyle(stripe, align as "left" | "right" | "center", numFmt);
      if (isTotal) {
        Object.assign(base, {
          font: { bold: true, name: FONT, sz: 10 },
          fill: { patternType: "solid", fgColor: { rgb: TOTAL_BG } },
        });
      }
      ws[addr] = { ...existing, t: typeof existing.v === "number" ? "n" : "s", s: base };
    }
  }

  ws["!cols"] = [
    { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 28 }, { wch: 12 },
    { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const filename = `CustomerInvoices_${report.from}_${report.to}.xlsx`;
  return { filename, buffer };
}

function formatDmY(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
