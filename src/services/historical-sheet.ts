import XLSX from "xlsx";
import { dateFromExcel } from "./upload-parser.js";
import { isQseRightsTicker } from "../db/debt-tickers.js";

export const SHEET_KINDS = ["securities", "prices", "indices", "client", "trades", "cash"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

type KeyGroup = { id: string; aliases: string[] };

export const SHEET_CATALOG: Record<SheetKind, {
  label: string;
  typicalFile: string;
  purpose: string;
  required: KeyGroup[];
  filenameHints: string[];
}> = {
  securities: {
    label: "Securities master",
    typicalFile: "CB_SEC_COMP.xls",
    purpose: "Listed tickers and company names (shared market data).",
    required: [
      { id: "TICKER_ID", aliases: ["ticker id", "ticker_id", "ticker"] },
    ],
    filenameHints: ["cb_sec_comp", "sec_comp"],
  },
  prices: {
    label: "Closing prices",
    typicalFile: "CB_PRICES.xls",
    purpose: "Daily closes used by as-of valuation.",
    required: [
      { id: "TICKER_ID", aliases: ["ticker id", "ticker_id", "ticker"] },
      { id: "PR_PRICE_DATE", aliases: ["pr price date", "pr_price_date", "price date"] },
      { id: "PR_C_PRICE", aliases: ["pr c price", "pr_c_price", "pr share price", "pr_share_price"] },
    ],
    filenameHints: ["cb_prices"],
  },
  indices: {
    label: "Index levels",
    typicalFile: "CH_CURRENT_INDEX.xls",
    purpose: "QERI / DSM (QE General) daily levels.",
    required: [
      { id: "CI_DATE", aliases: ["ci date", "ci_date", "date"] },
      { id: "CI_CURRENT_INDEX", aliases: ["ci current index", "ci_current_index", "current index"] },
    ],
    filenameHints: ["ch_current_index", "current_index"],
  },
  client: {
    label: "Client master",
    typicalFile: "CMClientDetails.xls",
    purpose: "Creates or updates a client + empty portfolio from broker KYC.",
    required: [
      { id: "Client Name", aliases: ["client name", "name"] },
      { id: "Client Code", aliases: ["client code", "client id", "account number"] },
    ],
    filenameHints: ["cmclientdetails", "clientdetails", "client_details"],
  },
  trades: {
    label: "Equity trades",
    typicalFile: "PMProfitLossTransaction.xls",
    purpose: "BUY / SELL / equity transfer rows for one client portfolio. Booking unit price prefers Buy Value / Sell Value over listed Price so WAC matches Gross. Not the IPMS Bulk Upload template.",
    required: [
      { id: "Order Side", aliases: ["order side"] },
      { id: "Ticker ID", aliases: ["ticker id", "ticker"] },
      { id: "Date", aliases: ["date"] },
      { id: "Price", aliases: ["price"] },
    ],
    filenameHints: ["pmprofitlosstransaction", "profitloss", "profit_loss"],
  },
  cash: {
    label: "Cash ledger",
    typicalFile: "FMClientAccountSummary.xls",
    purpose: "Non-trade cash (deposits, withdrawals, fees, dividends). Buy/Sell settlement rows are skipped; trade cash is rebuilt from blotter unit price (Buy/Sell Value ÷ qty).",
    required: [
      { id: "Post Date", aliases: ["post date", "posting date"] },
      { id: "Debit", aliases: ["debit"] },
      { id: "Credit", aliases: ["credit"] },
    ],
    filenameHints: ["fmclientaccountsummary", "accountsummary", "account_summary"],
  },
};

export function normalizeHeader(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function catalogPublic() {
  return SHEET_KINDS.map((kind) => {
    const spec = SHEET_CATALOG[kind];
    return {
      kind,
      label: spec.label,
      typicalFile: spec.typicalFile,
      purpose: spec.purpose,
      requiredKeys: spec.required.map((g) => g.id),
    };
  });
}

export function detectKindFromFilename(fileName: string): SheetKind | null {
  const n = fileName.toLowerCase().replace(/\s+/g, "");
  for (const kind of SHEET_KINDS) {
    if (SHEET_CATALOG[kind].filenameHints.some((h) => n.includes(h))) return kind;
  }
  return null;
}

function groupPresent(headers: string[], group: KeyGroup): boolean {
  return group.aliases.some((alias) => headers.includes(normalizeHeader(alias)));
}

export function validateHeaders(kind: SheetKind, rawHeaders: unknown[]): {
  ok: boolean;
  found: string[];
  missing: string[];
} {
  const headers = rawHeaders.map(normalizeHeader).filter(Boolean);
  const found: string[] = [];
  const missing: string[] = [];
  for (const group of SHEET_CATALOG[kind].required) {
    if (groupPresent(headers, group)) found.push(group.id);
    else missing.push(group.id);
  }
  return { ok: missing.length === 0, found, missing };
}

export function detectKindFromHeaders(rawHeaders: unknown[]): SheetKind | null {
  let best: { kind: SheetKind; score: number } | null = null;
  for (const kind of SHEET_KINDS) {
    const v = validateHeaders(kind, rawHeaders);
    if (!v.ok) continue;
    const score = v.found.length;
    if (!best || score > best.score) best = { kind, score };
  }
  return best?.kind ?? null;
}

export function pickField(row: Record<string, unknown>, aliases: string[]): unknown {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) map.set(normalizeHeader(k), v);
  for (const alias of aliases) {
    const n = normalizeHeader(alias);
    if (map.has(n)) return map.get(n);
  }
  for (const [k, v] of map) {
    if (aliases.some((a) => k.includes(normalizeHeader(a)) || normalizeHeader(a).includes(k))) return v;
  }
  return undefined;
}

export function cellDate(value: unknown): string | null {
  const s = dateFromExcel(value);
  return s || null;
}

export function cellNumber(value: unknown): number {
  if (value == null || value === "") return NaN;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

export function cellText(value: unknown): string {
  return String(value ?? "").trim();
}

export function readWorkbook(input: string | Buffer): XLSX.WorkBook {
  return typeof input === "string"
    ? XLSX.readFile(input, { cellDates: true })
    : XLSX.read(input, { type: "buffer", cellDates: true });
}

export function sheetObjectRows(wb: XLSX.WorkBook): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of wb.SheetNames) {
    out.push(...XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: null }));
  }
  return out;
}

export function firstSheetMatrix(wb: XLSX.WorkBook): unknown[][] {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
}

export function objectRowHeaders(rows: Record<string, unknown>[]): string[] {
  if (!rows[0]) return [];
  return Object.keys(rows[0]);
}

export function findHeaderRow(
  matrix: unknown[][],
  needles: string[],
  scanLimit = 40,
): { index: number; colMap: Map<string, number> } | null {
  const want = needles.map(normalizeHeader);
  const limit = Math.min(matrix.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] || [];
    const colMap = new Map<string, number>();
    row.forEach((cell, col) => {
      const n = normalizeHeader(cell);
      if (n) colMap.set(n, col);
    });
    if (want.every((n) => [...colMap.keys()].some((k) => k.includes(n) || n.includes(k)))) {
      return { index: i, colMap };
    }
  }
  return null;
}

function colFor(colMap: Map<string, number>, aliases: string[]): number {
  for (const alias of aliases) {
    const n = normalizeHeader(alias);
    if (colMap.has(n)) return colMap.get(n)!;
    for (const [k, col] of colMap) {
      if (k.includes(n) || n.includes(k)) return col;
    }
  }
  return -1;
}

export type ParsedStock = { ticker: string; companyName: string; sectorCode: string };
export type ParsedPrice = { ticker: string; date: string; price: number };
export type ParsedIndexPoint = { date: string; value: number; code: string; name: string };
export type ParsedClient = {
  name: string;
  email: string;
  joinDate: string;
  accountNumber: string;
  nin: string;
  notes: string;
};
export type ParsedTrade = {
  ticker: string;
  type: "BUY" | "SELL" | "CLIENT_TRANSFER";
  qty: number;
  price: number;
  date: string;
  notes: string | null;
  portfolioKey: string;
};
export type ParsedCash = {
  tradeDate: string;
  type: "deposit" | "withdrawal" | "fee" | "dividend" | "adjustment";
  amount: number;
  reference: string | null;
  notes: string | null;
};

export function parseSecurities(rows: Record<string, unknown>[]): { rows: ParsedStock[]; skipped: number } {
  const out: ParsedStock[] = [];
  let skipped = 0;
  for (const row of rows) {
    const ticker = cellText(pickField(row, ["ticker id", "ticker_id", "ticker"])).toUpperCase();
    if (!ticker || isQseRightsTicker(ticker)) {
      if (ticker) skipped++;
      continue;
    }
    out.push({
      ticker,
      companyName: cellText(pickField(row, ["sce long name", "sca long name", "company", "name"])) || ticker,
      sectorCode: cellText(pickField(row, ["sc sec code", "sector code", "sector"])),
    });
  }
  return { rows: out, skipped };
}

export function parsePrices(rows: Record<string, unknown>[]): { rows: ParsedPrice[]; skipped: number } {
  const out: ParsedPrice[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const ticker = cellText(pickField(row, ["ticker id", "ticker_id", "ticker"])).toUpperCase();
    if (!ticker || isQseRightsTicker(ticker)) {
      skipped++;
      continue;
    }
    const date = cellDate(pickField(row, ["pr price date", "pr_price_date", "price date", "date"]));
    const price = cellNumber(pickField(row, ["pr c price", "pr_c_price", "pr share price", "pr_share_price", "close", "price"]));
    if (!date || !Number.isFinite(price) || price <= 0) {
      skipped++;
      continue;
    }
    const key = `${ticker}|${date}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    out.push({ ticker, date, price });
  }
  return { rows: out, skipped };
}

export function parseIndexPoints(rows: Record<string, unknown>[]): { rows: ParsedIndexPoint[]; skipped: number } {
  const out: ParsedIndexPoint[] = [];
  let skipped = 0;
  for (const row of rows) {
    const date = cellDate(pickField(row, ["ci date", "ci_date", "date"]));
    const value = cellNumber(pickField(row, ["ci current index", "ci_current_index", "current index"]));
    if (!date || !Number.isFinite(value)) {
      skipped++;
      continue;
    }
    out.push({
      date,
      value,
      code: cellText(pickField(row, ["ci mrk index code", "ci_mrk_index_code", "index code"])).toUpperCase(),
      name: cellText(pickField(row, ["cie desc", "ci desc", "index name"])),
    });
  }
  return { rows: out, skipped };
}

function sanitizeClientEmail(raw: string, nin: string, accountNumber: string): string {
  const email = raw.replace(/\s+/g, "");
  if (email.includes("@") && !/[x*]/i.test(email)) return email.slice(0, 300);
  const key = nin || accountNumber || "imported";
  return `client.${key}@qsc.local`;
}

export function parseClients(rows: Record<string, unknown>[]): { rows: ParsedClient[]; skipped: number } {
  const out: ParsedClient[] = [];
  let skipped = 0;
  for (const row of rows) {
    const name = cellText(pickField(row, ["client name", "name"]));
    const accountNumber = cellText(pickField(row, ["client code", "client id", "account number"]));
    if (!name && !accountNumber) {
      skipped++;
      continue;
    }
    const nin = cellText(pickField(row, ["nin", "id number"]));
    const contract = cellText(pickField(row, ["contract no", "contract"]));
    const risk = cellText(pickField(row, ["risk management", "risk"]));
    out.push({
      name: name || `Imported client ${accountNumber || nin}`,
      email: sanitizeClientEmail(cellText(pickField(row, ["email"])), nin, accountNumber),
      joinDate: cellDate(pickField(row, ["creation date", "join date"])) || new Date().toISOString().slice(0, 10),
      accountNumber,
      nin,
      notes: `NIN ${nin || "—"}; Contract ${contract}; Risk ${risk}`.slice(0, 2000),
    });
  }
  return { rows: out, skipped };
}

/** Transfer-in is in-kind (CLIENT_TRANSFER, no cash). Transfer-out books as SELL at book; remaining cost uses average (cashless in the engine via notes). */
export function mapTradeSide(sideRaw: string): { type: "BUY" | "SELL" | "CLIENT_TRANSFER"; qtyAliases: string[] } | null {
  const side = sideRaw.trim().toLowerCase();
  if (side === "buy") {
    return { type: "BUY", qtyAliases: ["buy qty", "quantity", "qty"] };
  }
  if (side === "equity transfer-in" || side === "equity transfer in") {
    return { type: "CLIENT_TRANSFER", qtyAliases: ["buy qty", "quantity", "qty"] };
  }
  if (side === "sell" || side === "equity transfer-out" || side === "equity transfer out") {
    return { type: "SELL", qtyAliases: ["sell qty", "quantity", "qty"] };
  }
  return null;
}

function positiveNumber(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Broker blotter unit cost. File Buy Value often includes charges (≠ qty × listed Price).
 * Using Value ÷ qty lets qty×price replay match Gross and cash Debit/Credit without changing the live WAC engine.
 */
export function blotterUnitPrice(input: {
  type: "BUY" | "SELL" | "CLIENT_TRANSFER";
  qty: number;
  listedPrice: number;
  buyValue?: number;
  sellValue?: number;
}): number {
  const amount = input.type === "SELL"
    ? positiveNumber(input.sellValue ?? NaN)
    : positiveNumber(input.buyValue ?? NaN);
  if (amount != null && input.qty > 0) return amount / input.qty;
  return input.listedPrice;
}

export function parseTrades(rows: Record<string, unknown>[]): { rows: ParsedTrade[]; skipped: number } {
  const out: ParsedTrade[] = [];
  let skipped = 0;
  for (const row of rows) {
    const mapped = mapTradeSide(cellText(pickField(row, ["order side"])));
    const ticker = cellText(pickField(row, ["ticker id", "ticker"])).toUpperCase();
    if (!mapped || !ticker || isQseRightsTicker(ticker)) {
      skipped++;
      continue;
    }
    const qty = cellNumber(pickField(row, mapped.qtyAliases));
    const listedPrice = cellNumber(pickField(row, ["price"]));
    const buyValue = cellNumber(pickField(row, ["buy value"]));
    const sellValue = cellNumber(pickField(row, ["sell value"]));
    const date = cellDate(pickField(row, ["date"]));
    const price = blotterUnitPrice({
      type: mapped.type,
      qty,
      listedPrice,
      buyValue,
      sellValue,
    });
    if (!date || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
      skipped++;
      continue;
    }
    const invoice = cellText(pickField(row, ["invoice no", "invoice"]));
    out.push({
      ticker,
      type: mapped.type,
      qty,
      price,
      date,
      notes: invoice ? `Invoice ${invoice}; ${cellText(pickField(row, ["order side"]))}` : cellText(pickField(row, ["order side"])) || null,
      portfolioKey: cellText(pickField(row, ["portfolio id", "client code", "account"])),
    });
  }
  return { rows: out, skipped };
}

export function parseCashMatrix(matrix: unknown[][]): {
  rows: ParsedCash[];
  skipped: number;
  skippedBuySell: number;
  skippedBlank: number;
  headerIndex: number;
} {
  const found = findHeaderRow(matrix, ["post date"]);
  if (!found) return { rows: [], skipped: 0, skippedBuySell: 0, skippedBlank: 0, headerIndex: -1 };

  const dateCol = colFor(found.colMap, ["post date"]);
  const sideCol = colFor(found.colMap, ["order side"]);
  const docCol = colFor(found.colMap, ["doc no", "doc. no", "document no", "invoice"]);
  const descCol = colFor(found.colMap, ["description", "desc"]);
  const debitCol = colFor(found.colMap, ["debit"]);
  const creditCol = colFor(found.colMap, ["credit"]);

  const out: ParsedCash[] = [];
  let skipped = 0;
  let skippedBuySell = 0;
  let skippedBlank = 0;
  for (let i = found.index + 1; i < matrix.length; i++) {
    const row = matrix[i] || [];
    const postDate = cellDate(row[dateCol]);
    const orderSide = cellText(sideCol >= 0 ? row[sideCol] : "").toLowerCase();
    const desc = cellText(descCol >= 0 ? row[descCol] : "");
    const debit = debitCol >= 0 ? cellNumber(row[debitCol]) : 0;
    const credit = creditCol >= 0 ? cellNumber(row[creditCol]) : 0;
    if (!postDate) {
      skipped++;
      skippedBlank++;
      continue;
    }
    if (orderSide === "buy" || orderSide === "sell") {
      skipped++;
      skippedBuySell++;
      continue;
    }
    if (!desc && !(debit > 0) && !(credit > 0)) {
      skipped++;
      continue;
    }
    if (/starting balance/i.test(desc)) {
      skipped++;
      continue;
    }

    let type: ParsedCash["type"] = "adjustment";
    let amount = 0;
    const d = Number.isFinite(debit) ? debit : 0;
    const c = Number.isFinite(credit) ? credit : 0;
    if (c > 0 && d <= 0) {
      amount = c;
      if (/dividend|توزيع/i.test(desc)) type = "dividend";
      else if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      else type = "deposit";
    } else if (d > 0 && c <= 0) {
      amount = d;
      if (/fee|charge|عمولة/i.test(desc)) type = "fee";
      else type = "withdrawal";
    } else {
      skipped++;
      continue;
    }

    out.push({
      tradeDate: postDate,
      type,
      amount,
      reference: cellText(docCol >= 0 ? row[docCol] : "") || null,
      notes: desc || null,
    });
  }
  return { rows: out, skipped, skippedBuySell, skippedBlank, headerIndex: found.index };
}

export function inspectWorkbook(wb: XLSX.WorkBook, fileName: string, requestedKind?: SheetKind | null) {
  const objects = sheetObjectRows(wb);
  const matrix = firstSheetMatrix(wb);
  const objectHeaders = objectRowHeaders(objects);
  const cashHeader = findHeaderRow(matrix, ["post date"]);
  const matrixHeaders = cashHeader
    ? (matrix[cashHeader.index] || []).map((c) => String(c ?? ""))
    : (matrix[0] || []).map((c) => String(c ?? ""));

  const fromFile = detectKindFromFilename(fileName);
  const fromHeaders = detectKindFromHeaders(objectHeaders.length ? objectHeaders : matrixHeaders);
  const kind = requestedKind || fromFile || fromHeaders;
  const headersForKind = kind === "cash" ? matrixHeaders : (objectHeaders.length ? objectHeaders : matrixHeaders);
  const validation = kind
    ? validateHeaders(kind, headersForKind)
    : { ok: false, found: [] as string[], missing: ["unknown sheet type"] };

  return {
    kind,
    fromFile,
    fromHeaders,
    validation,
    objectHeaders,
    matrixHeaders,
    objectRowCount: objects.length,
    matrixRowCount: matrix.length,
    objects,
    matrix,
  };
}

export const PREVIEW_ROW_CAP = 150;

export type SheetIdentity = {
  name: string;
  email: string;
  accountNumber: string;
  mobile: string;
  nin: string;
  notes: string;
};

export type SheetIssue = {
  code: "MISSING_KEYS" | "KIND_MISMATCH" | "NO_PARSED_ROWS" | "SKIPPED_ROWS" | "MIXED_CLIENT_CODES";
  severity: "error" | "warning";
  detail: string;
};

export type SheetGridPreview = {
  headers: string[];
  rows: string[][];
  sheetRowCount: number;
  sheetColCount: number;
  truncated: boolean;
};

const IDENTITY_ALIASES: Record<keyof SheetIdentity, string[]> = {
  name: ["client name", "customer name", "full name", "account name"],
  email: ["email", "e mail"],
  accountNumber: ["account id", "account number", "client code", "portfolio id"],
  mobile: ["mobile", "mobile number", "phone", "tel", "gsm"],
  nin: ["nin", "id number", "qid", "client id"],
  notes: ["notes", "note", "remark", "remarks"],
};

function identityText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
    return String(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const sci = raw.match(/^(\d+(?:\.\d+)?)\s*[eE]\+?(\d+)$/);
  if (sci) return String(Math.round(Number(raw.replace(/\s+/g, ""))));
  return raw.replace(/\s+/g, " ");
}

function parseLabelValue(text: string): { label: string; value: string } | null {
  const match = text.match(/^(.{2,40}?)\s*[:：]\s*(.+)$/);
  if (!match) return null;
  return { label: normalizeHeader(match[1]), value: identityText(match[2]) };
}

export function formatPreviewCell(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return String(value).trim();
}

function emptyIdentity(): SheetIdentity {
  return { name: "", email: "", accountNumber: "", mobile: "", nin: "", notes: "" };
}

function assignIdentity(target: SheetIdentity, key: keyof SheetIdentity, raw: string) {
  const value = identityText(raw);
  if (target[key] || !value) return;
  if (key === "email") {
    const email = value.replace(/\s+/g, "");
    if (email.includes("@") && !/[x*]/i.test(email)) target.email = email.slice(0, 300);
    return;
  }
  target[key] = value.slice(0, 400);
}

function matchIdentityKey(label: string): keyof SheetIdentity | null {
  const n = normalizeHeader(label);
  if (!n) return null;
  for (const [key, aliases] of Object.entries(IDENTITY_ALIASES) as Array<[keyof SheetIdentity, string[]]>) {
    if (aliases.some((alias) => n === normalizeHeader(alias))) return key;
  }
  return null;
}

function pickExactField(row: Record<string, unknown>, aliases: string[]): unknown {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) map.set(normalizeHeader(k), v);
  for (const alias of aliases) {
    const n = normalizeHeader(alias);
    if (map.has(n)) return map.get(n);
  }
  return undefined;
}

export function extractSheetIdentity(
  objects: Record<string, unknown>[],
  matrix: unknown[][],
): SheetIdentity {
  const out = emptyIdentity();
  const noteBits: string[] = [];
  const pushNote = (value: string) => {
    const text = identityText(value);
    if (text && !noteBits.includes(text)) noteBits.push(text);
  };

  const limit = Math.min(matrix.length, 40);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] || [];
    const filled = row.filter((cell) => identityText(cell)).length;
    for (let c = 0; c < row.length; c++) {
      const cell = identityText(row[c]);
      if (!cell) continue;
      const labeled = parseLabelValue(cell);
      if (labeled) {
        const key = matchIdentityKey(labeled.label);
        if (key) assignIdentity(out, key, labeled.value);
        if (normalizeHeader(labeled.label).includes("from date") || labeled.label.includes("to date")) {
          pushNote(cell);
        }
        continue;
      }
      if (filled > 3) continue;
      const value = identityText(row[c + 1]);
      if (!value || matchIdentityKey(value)) continue;
      const key = matchIdentityKey(cell);
      if (key) assignIdentity(out, key, value);
    }
  }

  for (let i = 0; i < limit - 1; i++) {
    const header = (matrix[i] || []).map((cell) => normalizeHeader(cell));
    const identityHeaders = header.filter((h) =>
      h === "client id" || h === "client code" || h === "account id" || h === "account number" || h === "account name" || h === "client name",
    );
    if (identityHeaders.length < 2) continue;
    const data = matrix[i + 1] || [];
    header.forEach((label, col) => {
      const key = matchIdentityKey(label);
      if (key) assignIdentity(out, key, identityText(data[col]));
      if (label === "account type" || label === "currency") pushNote(identityText(data[col]));
    });
    break;
  }

  const scan = objects.slice(0, 80);
  for (const [key, aliases] of Object.entries(IDENTITY_ALIASES) as Array<[keyof SheetIdentity, string[]]>) {
    for (const row of scan) {
      assignIdentity(out, key, identityText(pickExactField(row, aliases)));
      if (out[key]) break;
    }
  }

  if (noteBits.length) {
    const extra = noteBits.join(" · ");
    out.notes = [out.notes, extra].filter(Boolean).join(" · ").slice(0, 400);
  }
  if (out.nin && out.accountNumber && out.nin === out.accountNumber) out.nin = "";
  return out;
}

function uniqueFieldValues(objects: Record<string, unknown>[], aliases: string[]): string[] {
  const seen = new Set<string>();
  for (const row of objects) {
    const v = cellText(pickField(row, aliases));
    if (v) seen.add(v);
  }
  return [...seen];
}

function objectsToGrid(objects: Record<string, unknown>[], cap: number): SheetGridPreview {
  const headers: string[] = [];
  const seen = new Set<string>();
  const headerScan = objects.slice(0, Math.min(objects.length, Math.max(cap, 40)));
  for (const row of headerScan) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const truncated = objects.length > cap;
  const slice = objects.slice(0, cap);
  return {
    headers,
    rows: slice.map((row) => headers.map((key) => formatPreviewCell(row[key]))),
    sheetRowCount: objects.length,
    sheetColCount: headers.length,
    truncated,
  };
}

function matrixToGrid(matrix: unknown[][], headerIndex: number, cap: number): SheetGridPreview {
  const start = headerIndex >= 0 ? headerIndex : 0;
  let colCount = 0;
  for (const row of matrix) colCount = Math.max(colCount, (row || []).length);
  const headerRow = matrix[start] || [];
  const headers = Array.from({ length: colCount }, (_, i) => {
    const label = String(headerRow[i] ?? "").trim();
    return label || `Col ${i + 1}`;
  });
  const body = matrix.slice(start + 1).filter((row) =>
    (row || []).some((cell) => String(cell ?? "").trim() !== ""),
  );
  const truncated = body.length > cap;
  return {
    headers,
    rows: body.slice(0, cap).map((row) => headers.map((_, i) => formatPreviewCell((row || [])[i]))),
    sheetRowCount: body.length,
    sheetColCount: colCount,
    truncated,
  };
}

function parsedCountFor(inspect: ReturnType<typeof inspectWorkbook>): {
  parsedCount: number;
  skippedCount: number;
  headerIndex?: number;
  skippedBuySell?: number;
} {
  const { kind, objects, matrix } = inspect;
  if (!kind) return { parsedCount: 0, skippedCount: 0 };
  if (kind === "securities") {
    const p = parseSecurities(objects);
    return { parsedCount: p.rows.length, skippedCount: p.skipped };
  }
  if (kind === "prices") {
    const p = parsePrices(objects);
    return { parsedCount: p.rows.length, skippedCount: p.skipped };
  }
  if (kind === "indices") {
    const p = parseIndexPoints(objects);
    return { parsedCount: p.rows.length, skippedCount: p.skipped };
  }
  if (kind === "client") {
    const p = parseClients(objects);
    return { parsedCount: p.rows.length, skippedCount: p.skipped };
  }
  if (kind === "trades") {
    const p = parseTrades(objects);
    return { parsedCount: p.rows.length, skippedCount: p.skipped };
  }
  const p = parseCashMatrix(matrix);
  return {
    parsedCount: p.rows.length,
    skippedCount: p.skipped,
    headerIndex: p.headerIndex,
    skippedBuySell: p.skippedBuySell,
  };
}

export function collectSheetIssues(
  inspect: ReturnType<typeof inspectWorkbook>,
  parsedCount: number,
  skippedCount: number,
  skippedBuySell = 0,
): SheetIssue[] {
  const issues: SheetIssue[] = [];
  if (inspect.validation.missing.length) {
    issues.push({ code: "MISSING_KEYS", severity: "error", detail: inspect.validation.missing.join(", ") });
  }
  if (inspect.fromFile && inspect.fromHeaders && inspect.fromFile !== inspect.fromHeaders) {
    issues.push({
      code: "KIND_MISMATCH",
      severity: "warning",
      detail: `${inspect.fromFile} / ${inspect.fromHeaders}`,
    });
  }
  if (inspect.validation.ok && parsedCount === 0) {
    issues.push({ code: "NO_PARSED_ROWS", severity: "error", detail: "0" });
  }
  const unexpectedSkips = skippedCount - skippedBuySell;
  if (unexpectedSkips > 0 && skippedBuySell < skippedCount) {
    issues.push({ code: "SKIPPED_ROWS", severity: "warning", detail: String(unexpectedSkips) });
  }
  const codes = uniqueFieldValues(inspect.objects, IDENTITY_ALIASES.accountNumber);
  if (codes.length > 1) {
    issues.push({ code: "MIXED_CLIENT_CODES", severity: "warning", detail: codes.slice(0, 8).join(", ") });
  }
  return issues;
}

export function previewFromInspect(inspect: ReturnType<typeof inspectWorkbook>, sampleSize = 8) {
  const { kind, objects, matrix } = inspect;
  const parsed = parsedCountFor(inspect);
  const cashHeader = findHeaderRow(matrix, ["post date"]);
  const grid = kind === "cash"
    ? matrixToGrid(matrix, cashHeader?.index ?? parsed.headerIndex ?? 0, PREVIEW_ROW_CAP)
    : objectsToGrid(objects, PREVIEW_ROW_CAP);
  const identity = extractSheetIdentity(objects, matrix);
  const issues = collectSheetIssues(inspect, parsed.parsedCount, parsed.skippedCount, parsed.skippedBuySell);
  const sample = grid.rows.slice(0, sampleSize).map((row) =>
    Object.fromEntries(grid.headers.map((header, i) => [header, row[i] ?? ""])),
  );
  return {
    sample,
    parsedCount: parsed.parsedCount,
    skippedCount: parsed.skippedCount,
    skippedBuySell: parsed.skippedBuySell ?? 0,
    headerIndex: parsed.headerIndex,
    grid,
    identity,
    issues,
  };
}
