import multer from "multer";
import path from "path";
import XLSX from "xlsx";
import fs from "fs";

const uploadDir = path.resolve(import.meta.dirname, "..", "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

export const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
/** QSC broker workbooks (especially CB_PRICES) exceed the 10MB stock-upload cap. */
export const historicalUpload = multer({ storage, limits: { fileSize: 80 * 1024 * 1024 } });

function readExcelFile(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return XLSX.read(buf, { type: "buffer" });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Return YYYY-MM-DD if y/m/d is a real calendar date, else "". */
function ymd(year: number, month: number, day: number): string {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse an Excel/cell value to YYYY-MM-DD.
 * Numeric dates like 02-07-2024 / 02/07/2024 are read as dd-mm-yyyy (2 July),
 * which is the Qatar / template convention. If that is not a valid date
 * (e.g. 08/15/2024), fall back to mm-dd-yyyy.
 */
export function dateFromExcel(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 20000 && raw < 80000) {
    const d = new Date(Math.round((raw - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return "";
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((parseFloat(s) - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const named = s.match(/^(\d{1,2})[\/\-.\s]+([A-Za-z]{3})[a-z]*[\/\-.\s]+(\d{4})/i);
  if (named) {
    const month = MONTH_ABBR[named[2].slice(0, 3).toLowerCase()];
    return month ? ymd(Number(named[3]), month, Number(named[1])) : "";
  }

  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:\s|$)/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    return ymd(year, b, a) || ymd(year, a, b);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
    const found = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "") return row[found];
  }
  return undefined;
}

export interface IndexDataPointRow {
  date: string;
  value: number;
  openValue: number | null;
  highValue: number | null;
  lowValue: number | null;
}

export function parseIndexExcel(filePath: string): IndexDataPointRow[] {
  const workbook = readExcelFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  return rows.map((row) => {
    const dateRaw = pick(row, "CI_DATE", "date", "Date");
    const valueRaw = pick(row, "CI_CURRENT_INDEX", "CI_LAST_CLOSING", "value", "Value", "close", "Close");
    const openRaw = pick(row, "CI_OPEN_INDEX", "open", "Open", "openValue");
    const highRaw = pick(row, "CI_HIGH_INDEX", "high", "High", "highValue");
    const lowRaw = pick(row, "CI_LOW_INDEX", "low", "Low", "lowValue");
    // Fallback to first two columns for legacy templates
    const keys = Object.keys(row);
    const date = dateFromExcel(String(dateRaw ?? row[keys[0]] ?? ""));
    const value = numOrNull(valueRaw ?? row[keys[1]] ?? 0) ?? 0;
    return {
      date,
      value,
      openValue: numOrNull(openRaw),
      highValue: numOrNull(highRaw),
      lowValue: numOrNull(lowRaw),
    };
  }).filter((r) => r.date && !isNaN(r.value) && r.value > 0);
}

export function parseStockPriceExcel(filePath: string): { date: string; price: number }[] {
  const workbook = readExcelFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  return rows.map((row) => {
    const keys = Object.keys(row);
    return { date: dateFromExcel(String(row[keys[0]] ?? "")), price: Number(row[keys[1]] ?? 0) };
  }).filter((r) => r.date && !isNaN(r.price));
}

export function cleanupUpload(filePath: string) {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

export interface BulkStockRow {
  ticker: string;
  date: string;
  price: number;
  sharePrice: number | null;
  ask: number | null;
  offer: number | null;
  orderNum: number | null;
  volume: number | null;
  month: string | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number | null;
}

export function parseBulkStockMasterExcel(filePath: string): BulkStockRow[] {
  const workbook = readExcelFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  return rows.map((row) => {
    const closePrice = numOrNull(row.PR_C_PRICE ?? row["PR_C_PRICE"]);
    const sharePrice = numOrNull(row.PR_SHARE_PRICE ?? row["PR_SHARE_PRICE"]);
    const price = closePrice ?? sharePrice ?? numOrNull(row.price) ?? 0;
    return {
      ticker: String(row.TICKER_ID ?? row.ticker ?? row["TICKER_ID"] ?? "").toUpperCase(),
      date: dateFromExcel(String(row.PR_PRICE_DATE ?? row.date ?? row["PR_PRICE_DATE"] ?? "")),
      price,
      sharePrice,
      ask: numOrNull(row.PR_ASK ?? row["PR_ASK"]),
      offer: numOrNull(row.PR_OFF ?? row["PR_OFF"]),
      orderNum: numOrNull(row.PR_O_NUM ?? row["PR_O_NUM"]),
      volume: numOrNull(row.PR_VOL ?? row["PR_VOL"]),
      month: strOrNull(row.PR_MON ?? row["PR_MON"]),
      openPrice: numOrNull(row.PR_OP_PRICE ?? row["PR_OP_PRICE"]),
      highPrice: numOrNull(row.PR_H_PRICE ?? row["PR_H_PRICE"]),
      lowPrice: numOrNull(row.PR_L_PRICE ?? row["PR_L_PRICE"]),
      closePrice,
    };
  }).filter((r) => r.ticker && r.date && !isNaN(r.price) && r.price > 0);
}

export interface TransactionBulkRow {
  ticker: string;
  type: "BUY" | "SELL" | "TRANSFER" | "CLIENT_TRANSFER";
  quantity: number;
  date: string;
  price: number;
  /** Cash amount for TRANSFER rows (treated as a withdrawal from the portfolio's cash balance). */
  amount: number | null;
  /** 1-based Excel row number (header is row 1). */
  excelRow: number;
}

export function parseTransactionBulkExcel(filePath: string): TransactionBulkRow[] {
  const workbook = readExcelFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: "" });
  return rows.map((row, idx) => {
    const keys = Object.keys(row);
    let ticker = String(pick(row, "ticker", "Ticker", "TICKER") ?? "").toUpperCase().trim();
    const typeRaw = String(pick(row, "type") ?? row[keys[1]] ?? "BUY").toUpperCase().trim();
    if (!ticker && keys[0] && !["type", "date", "quantity", "price", "amount"].includes(keys[0].toLowerCase())) {
      ticker = String(row[keys[0]] ?? "").toUpperCase().trim();
    }
    if (ticker === "TICKER" || typeRaw === "TYPE" || typeRaw === "DATE") return null;
    if (!ticker && typeRaw !== "TRANSFER" && typeRaw !== "WITHDRAWAL" && typeRaw !== "CLIENT_TRANSFER" && typeRaw !== "TRANSFER_IN") return null;
    const type: "BUY" | "SELL" | "TRANSFER" | "CLIENT_TRANSFER" =
      typeRaw === "SELL" ? "SELL"
      : typeRaw === "TRANSFER" || typeRaw === "WITHDRAWAL" ? "TRANSFER"
      : typeRaw === "CLIENT_TRANSFER" || typeRaw === "TRANSFER_IN" || typeRaw === "CLIENTTRANSFER" ? "CLIENT_TRANSFER"
      : "BUY";
    const priceRaw = pick(row, "price", "Price", "fill_price", "fillPrice") ?? row[keys[4]];
    const amountRaw = pick(row, "amount", "Amount", "AMOUNT");
    const dateRaw = pick(row, "date", "Date", "trade_date", "tradeDate") ?? row[keys[3]];
    return {
      ticker,
      type,
      quantity: Number(pick(row, "quantity", "Quantity", "qty") ?? row[keys[2]] ?? 0),
      date: dateFromExcel(dateRaw),
      price: Number(priceRaw ?? 0),
      amount: numOrNull(amountRaw),
      excelRow: idx + 2,
    };
  }).filter((r): r is TransactionBulkRow => {
    if (!r || !r.date) return false;
    if (r.type === "TRANSFER") return r.amount != null && r.amount > 0;
    return !!r.ticker && r.quantity > 0 && Number.isFinite(r.price) && r.price > 0;
  });
}
