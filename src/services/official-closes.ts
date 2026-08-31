import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { writeAudit } from "./audit.js";
import {
  inspectWorkbook,
  parsePrices,
  readWorkbook,
  type ParsedPrice,
} from "./historical-sheet.js";
import { normalizeMarkdownHeader, parseKbMarkdownTable, splitMarkdownRow } from "./kb-markdown.js";

const BATCH = 500;
export const SAMPLE_CLOSE_TICKER = "MHAR";
export const SAMPLE_CLOSE_DATE = "2024-12-01";

export function defaultKbTickerPricesPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../KB/Market-Data/Company-Closing-Prices-By-Ticker.md");
}

export function parseKbPriceMarkdown(markdown: string): { rows: ParsedPrice[]; skipped: number } {
  return parsePrices(parseKbMarkdownTable(markdown));
}

async function stockIdByTicker(): Promise<Map<string, string>> {
  const stocks = await db.select({ id: schema.stocks.id, ticker: schema.stocks.ticker }).from(schema.stocks);
  return new Map(stocks.map((s) => [s.ticker.toUpperCase(), s.id]));
}

async function insertCloseBatches(inserts: { stockId: string; date: string; price: string; closePrice: string }[]) {
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    await db.insert(schema.stockPrices).values(batch).onConflictDoUpdate({
      target: [schema.stockPrices.stockId, schema.stockPrices.date],
      set: {
        price: sql`excluded.price`,
        closePrice: sql`excluded.close_price`,
      },
    });
  }
}

export async function upsertParsedOfficialCloses(parsed: ParsedPrice[]): Promise<{
  upserted: number;
  unknownTickers: number;
  unknownSample: string[];
}> {
  const ids = await stockIdByTicker();
  const unknown = new Set<string>();
  const inserts: { stockId: string; date: string; price: string; closePrice: string }[] = [];
  for (const row of parsed) {
    const stockId = ids.get(row.ticker.toUpperCase());
    if (!stockId) {
      unknown.add(row.ticker.toUpperCase());
      continue;
    }
    const price = String(row.price);
    inserts.push({ stockId, date: row.date, price, closePrice: price });
  }
  await insertCloseBatches(inserts);
  return {
    upserted: inserts.length,
    unknownTickers: unknown.size,
    unknownSample: [...unknown].slice(0, 20),
  };
}

export async function importKbOfficialCloses(opts: {
  filePath?: string;
  userId?: string | null;
}): Promise<{
  filePath: string;
  parsed: number;
  skippedParse: number;
  upserted: number;
  unknownTickers: number;
  unknownSample: string[];
}> {
  return importKbOfficialClosesStream(opts);
}

/** Streamed import for the large KB file (same result as importKbOfficialCloses). */
export async function importKbOfficialClosesStream(opts: {
  filePath?: string;
  userId?: string | null;
}): Promise<{
  filePath: string;
  parsed: number;
  skippedParse: number;
  upserted: number;
  unknownTickers: number;
  unknownSample: string[];
}> {
  const filePath = opts.filePath || defaultKbTickerPricesPath();
  await fs.access(filePath);
  const ids = await stockIdByTicker();
  const unknown = new Set<string>();
  let headers: string[] = [];
  let parsed = 0;
  let skippedParse = 0;
  let upserted = 0;
  let buffer: ParsedPrice[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];
    const inserts: { stockId: string; date: string; price: string; closePrice: string }[] = [];
    for (const row of chunk) {
      const stockId = ids.get(row.ticker.toUpperCase());
      if (!stockId) continue;
      const price = String(row.price);
      inserts.push({ stockId, date: row.date, price, closePrice: price });
    }
    if (inserts.length) await insertCloseBatches(inserts);
    upserted += inserts.length;
  };

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const cells = splitMarkdownRow(line);
    if (cells.length === 0) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;
    if (headers.length === 0) {
      headers = cells.map(normalizeMarkdownHeader);
      continue;
    }
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    const one = parsePrices([obj]);
    skippedParse += one.skipped;
    if (one.rows[0]) {
      parsed += 1;
      const row = one.rows[0];
      if (!ids.has(row.ticker.toUpperCase())) unknown.add(row.ticker.toUpperCase());
      buffer.push(row);
      if (buffer.length >= BATCH) await flush();
    }
  }
  await flush();

  await writeAudit({
    userId: opts.userId ?? null,
    action: "update",
    objectType: "stock_prices",
    objectId: null,
    newValue: { source: filePath, parsed, skippedParse, upserted, unknownTickers: unknown.size },
    reason: "Import official closes from KB CB_PRICES markdown",
  });

  return {
    filePath,
    parsed,
    skippedParse,
    upserted,
    unknownTickers: unknown.size,
    unknownSample: [...unknown].slice(0, 20),
  };
}

export async function importOfficialClosesFromWorkbook(filePath: string, fileName: string, userId?: string | null) {
  const inspect = inspectWorkbook(readWorkbook(filePath), fileName, "prices");
  const parsed = parsePrices(inspect.objects);
  const result = await upsertParsedOfficialCloses(parsed.rows);
  await writeAudit({
    userId: userId ?? null,
    action: "update",
    objectType: "stock_prices",
    objectId: null,
    newValue: { fileName, parsed: parsed.rows.length, skippedParse: parsed.skipped, ...result },
    reason: "Upload official closes workbook",
  });
  return { parsed: parsed.rows.length, skippedParse: parsed.skipped, ...result };
}

export async function upsertOfficialClose(input: {
  ticker: string;
  date: string;
  price: number;
  userId?: string | null;
}) {
  const ticker = input.ticker.trim().toUpperCase();
  const date = input.date.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error("date must be YYYY-MM-DD") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    const err = new Error("close price must be > 0") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const [stockRow] = await db.select().from(schema.stocks)
    .where(sql`upper(${schema.stocks.ticker}) = ${ticker}`)
    .limit(1);
  if (!stockRow) {
    const err = new Error(`Ticker ${ticker} is not in stock master`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const price = String(input.price);
  await db.insert(schema.stockPrices).values({
    stockId: stockRow.id,
    date,
    price,
    closePrice: price,
  }).onConflictDoUpdate({
    target: [schema.stockPrices.stockId, schema.stockPrices.date],
    set: { price: sql`excluded.price`, closePrice: sql`excluded.close_price` },
  });
  await writeAudit({
    userId: input.userId ?? null,
    action: "update",
    objectType: "stock_prices",
    objectId: stockRow.id,
    newValue: { ticker, date, price: input.price },
    reason: "Manual official close",
  });
  return { ticker: stockRow.ticker, date, price: input.price, stockId: stockRow.id };
}

export async function deleteOfficialClose(ticker: string, date: string, userId?: string | null) {
  const key = ticker.trim().toUpperCase();
  const day = date.trim().slice(0, 10);
  const [stock] = await db.select().from(schema.stocks)
    .where(sql`upper(${schema.stocks.ticker}) = ${key}`)
    .limit(1);
  if (!stock) {
    const err = new Error(`Ticker ${key} is not in stock master`) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const deleted = await db.delete(schema.stockPrices).where(
    and(eq(schema.stockPrices.stockId, stock.id), eq(schema.stockPrices.date, day)),
  ).returning({ date: schema.stockPrices.date });
  if (deleted.length === 0) {
    const err = new Error("Close row not found") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  await writeAudit({
    userId: userId ?? null,
    action: "delete",
    objectType: "stock_prices",
    objectId: stock.id,
    newValue: { ticker: key, date: day },
    reason: "Manual official close delete",
  });
  return { ok: true };
}

export async function listOfficialCloses(opts: {
  ticker?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const filters = [];
  if (opts.ticker?.trim()) {
    filters.push(sql`upper(${schema.stocks.ticker}) like ${`${opts.ticker.trim().toUpperCase()}%`}`);
  }
  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    filters.push(gte(schema.stockPrices.date, opts.from));
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    filters.push(lte(schema.stockPrices.date, opts.to));
  }
  const where = filters.length ? and(...filters) : undefined;

  const [totalRow] = await db.select({ c: sql<number>`count(*)::int` })
    .from(schema.stockPrices)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockPrices.stockId))
    .where(where);

  const rows = await db.select({
    stockId: schema.stocks.id,
    ticker: schema.stocks.ticker,
    companyName: schema.stocks.companyName,
    date: schema.stockPrices.date,
    price: schema.stockPrices.price,
    closePrice: schema.stockPrices.closePrice,
  })
    .from(schema.stockPrices)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockPrices.stockId))
    .where(where)
    .orderBy(desc(schema.stockPrices.date), asc(schema.stocks.ticker))
    .limit(limit)
    .offset(offset);

  return {
    total: totalRow?.c ?? 0,
    limit,
    offset,
    data: rows.map((r) => ({
      stockId: r.stockId,
      ticker: r.ticker,
      companyName: r.companyName,
      date: String(r.date).slice(0, 10),
      price: Number(r.price),
      closePrice: r.closePrice != null ? Number(r.closePrice) : Number(r.price),
    })),
  };
}

export async function officialClosesSummary() {
  const [totals] = await db.select({
    rows: sql<number>`count(*)::int`,
    minDate: sql<string>`min(${schema.stockPrices.date})`,
    maxDate: sql<string>`max(${schema.stockPrices.date})`,
  }).from(schema.stockPrices);

  const [mhar] = await db.select({
    price: schema.stockPrices.price,
    date: schema.stockPrices.date,
  })
    .from(schema.stockPrices)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockPrices.stockId))
    .where(and(
      sql`upper(${schema.stocks.ticker}) = ${SAMPLE_CLOSE_TICKER}`,
      eq(schema.stockPrices.date, SAMPLE_CLOSE_DATE),
    ))
    .limit(1);

  let kbFileExists = false;
  try {
    await fs.access(defaultKbTickerPricesPath());
    kbFileExists = true;
  } catch {
    kbFileExists = false;
  }

  return {
    rowCount: totals?.rows ?? 0,
    minDate: totals?.minDate ? String(totals.minDate).slice(0, 10) : null,
    maxDate: totals?.maxDate ? String(totals.maxDate).slice(0, 10) : null,
    kbFile: "KB/Market-Data/Company-Closing-Prices-By-Ticker.md",
    kbFileExists,
    sample: {
      ticker: SAMPLE_CLOSE_TICKER,
      date: SAMPLE_CLOSE_DATE,
      close: mhar ? Number(mhar.price) : null,
    },
  };
}

/** Bloomberg-style header e.g. `MHAR QD Equity` → `MHAR`. */
export function bloombergEquityTicker(header: string): string | null {
  const m = String(header || "").trim().match(/^([A-Za-z0-9]+)\s+QD\s+Equity$/i);
  return m ? m[1].toUpperCase() : null;
}

function isoDateCell(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Parse `Last price ` sheet from AI / Bloomberg wide workbook.
 * Row 0 = tickers, row 1 = labels, row 2+ = dates + closes. Skips DSM/QERI index columns.
 */
export function parseBloombergLastPriceRows(
  rows: unknown[][],
  opts?: { fromDate?: string },
): { rows: ParsedPrice[]; skipped: number; tickers: string[] } {
  const fromDate = opts?.fromDate;
  if (!rows.length) return { rows: [], skipped: 0, tickers: [] };
  const headers = rows[0] || [];
  const cols: { index: number; ticker: string }[] = [];
  for (let i = 1; i < headers.length; i++) {
    const ticker = bloombergEquityTicker(String(headers[i] ?? ""));
    if (ticker) cols.push({ index: i, ticker });
  }
  const out: ParsedPrice[] = [];
  let skipped = 0;
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const date = isoDateCell(row[0]);
    if (!date) {
      skipped += 1;
      continue;
    }
    if (fromDate && date < fromDate) continue;
    for (const col of cols) {
      const raw = row[col.index];
      if (raw == null || raw === "") {
        skipped += 1;
        continue;
      }
      const price = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(price) || price <= 0) {
        skipped += 1;
        continue;
      }
      out.push({ ticker: col.ticker, date, price });
    }
  }
  return { rows: out, skipped, tickers: cols.map((c) => c.ticker) };
}

export function defaultAiBloombergPricesPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../files/AI prices as of 30.08.2026.xlsx");
}

/** Import official closes from client AI/Bloomberg workbook (س-22 file 2026-08-30). */
export async function importAiBloombergOfficialCloses(opts: {
  filePath?: string;
  sheetName?: string;
  fromDate?: string;
  userId?: string | null;
}): Promise<{
  filePath: string;
  sheetName: string;
  parsed: number;
  skippedParse: number;
  upserted: number;
  unknownTickers: number;
  unknownSample: string[];
  tickers: string[];
  fromDate: string;
}> {
  const XLSX = (await import("xlsx")).default;
  const filePath = opts.filePath || defaultAiBloombergPricesPath();
  await fs.access(filePath);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetName =
    opts.sheetName ||
    wb.SheetNames.find((n) => /^last\s*price/i.test(n.trim())) ||
    wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
  const fromDate = opts.fromDate ?? "2026-08-19";
  const parsed = parseBloombergLastPriceRows(matrix, { fromDate });
  const result = await upsertParsedOfficialCloses(parsed.rows);
  await writeAudit({
    userId: opts.userId ?? null,
    action: "update",
    objectType: "stock_prices",
    objectId: null,
    newValue: {
      source: filePath,
      sheetName,
      fromDate,
      parsed: parsed.rows.length,
      skippedParse: parsed.skipped,
      ...result,
    },
    reason: "Import official closes from AI Bloomberg Last price workbook (س-22)",
  });
  return {
    filePath,
    sheetName,
    parsed: parsed.rows.length,
    skippedParse: parsed.skipped,
    upserted: result.upserted,
    unknownTickers: result.unknownTickers,
    unknownSample: result.unknownSample,
    tickers: parsed.tickers,
    fromDate,
  };
}
