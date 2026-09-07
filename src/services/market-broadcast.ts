/**
 * QSC live market broadcast (meeting 3 / Phase 7).
 *
 * - Ingests Hub/WebSocket (or sample JSON) MarketWatch → in-memory Last Price.
 * - Portfolio MV for "today" may use Last Price (session).
 * - Official close for historical asOf stays stock_prices.
 * - Session-end: persist Last Price → stock_prices as that day's close (س-25).
 * - Never write every intraday tick to stock_prices (D-016).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { and, eq } from "drizzle-orm";

/** Lazy DB import so parser/unit tests do not require DATABASE_URL. */
async function getDb() {
  const mod = await import("../db/connection.js");
  return mod;
}

export const BROADCAST_OBJECT_NAMES = [
  "ExchangesSummary",
  "MarketWatch",
  "trades",
  "MarketDepthByPrice",
  "MarketIndicies",
] as const;

export type LiveQuote = {
  symbol: string;
  lastTradePrice: number;
  closePrice: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  netChange: number | null;
  netChangePerc: number | null;
  bidPrice: number | null;
  offerPrice: number | null;
  totalVolume: number | null;
  totalValue: number | null;
  companyName: string | null;
  companyNameAr: string | null;
  sector: string | null;
  updatedAt: string;
};

export type LiveIndex = {
  code: string;
  nameEn: string;
  nameAr: string | null;
  current: number;
  change: number | null;
  changePerc: number | null;
  high: number | null;
  low: number | null;
  updatedAt: string;
};

export type LiveExchangeSummary = {
  exchangeId: string;
  nameEn: string;
  nameAr: string | null;
  currentValue: number | null;
  netChange: number | null;
  netChangePerc: number | null;
  volume: number | null;
  turnOver: number | null;
  symbolsUp: number | null;
  symbolsDown: number | null;
  symbolsUnchanged: number | null;
  lastUpdateTime: string | null;
};

type BroadcastStatus = {
  configured: boolean;
  connected: boolean;
  sampleLoaded: boolean;
  quoteCount: number;
  indexCount: number;
  lastMessageAt: string | null;
  sessionOpen: boolean;
  ingestOfficialCloses: boolean;
  valuationSource: "official_close" | "last_price_session";
  objectsNamedByQsc: string[];
  blockedReason: "NO_BROADCAST_WS_URL" | "IDLE" | null;
  hubUrl: string | null;
  sessionHoursQatar: string;
  exchange: LiveExchangeSummary | null;
};

const quotes = new Map<string, LiveQuote>();
const indices = new Map<string, LiveIndex>();
let exchangeSummary: LiveExchangeSummary | null = null;
let lastMessageAt: string | null = null;
let connected = false;
let sampleLoaded = false;
let ws: WebSocket | null = null;
let closeCronStarted = false;

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function todayQatarIso(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Qatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function qatarHourMinute(d = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Qatar",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { hour, minute };
}

/** Service window from meeting: 08:00–15:00 Asia/Qatar. */
export function isBroadcastSessionOpen(d = new Date()): boolean {
  const { hour, minute } = qatarHourMinute(d);
  const mins = hour * 60 + minute;
  return mins >= 8 * 60 && mins < 15 * 60;
}

export function isBroadcastUrlConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.BROADCAST_WS_URL || "").trim());
}

function samplePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = (env.BROADCAST_SAMPLE_PATH || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../samples/BroadcastData.json"),
    path.resolve(here, "../../../meeting/meeting_3/BroadcastData.json"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function parseBroadcastPayload(payload: unknown): {
  quotes: LiveQuote[];
  indices: LiveIndex[];
  exchange: LiveExchangeSummary | null;
} {
  const root = payload as Record<string, unknown>;
  const dataArr = Array.isArray(root.Data) ? root.Data : Array.isArray(root.data) ? root.data : [root];
  const bag = (dataArr[0] ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const outQuotes: LiveQuote[] = [];
  const outIndices: LiveIndex[] = [];
  let outExchange: LiveExchangeSummary | null = null;

  for (let i = 1; i <= 8; i++) {
    const name = String(bag[`objectName${i}`] ?? bag[`ObjectName${i}`] ?? "");
    const value = bag[`objectValue${i}`] ?? bag[`ObjectValue${i}`];
    if (!name) continue;

    if (/exchanges.?summary|session.?summary/i.test(name) && Array.isArray(value) && value[0]) {
      const row = value[0] as Record<string, unknown>;
      outExchange = {
        exchangeId: String(row.exchangeID ?? row.exchangeId ?? "QE"),
        nameEn: String(row.exchangeNameE ?? row.e_M_NAME ?? "Qatar Exchange"),
        nameAr: row.exchangeNameA != null ? String(row.exchangeNameA) : null,
        currentValue: toNum(row.currentValue),
        netChange: toNum(row.netChange),
        netChangePerc: toNum(row.netChangePerc),
        volume: toNum(row.volume),
        turnOver: toNum(row.turnOver),
        symbolsUp: toNum(row.symbolsUP),
        symbolsDown: toNum(row.symbolsDown),
        symbolsUnchanged: toNum(row.symbolsUnChange),
        lastUpdateTime: row.lastUpdateTime != null ? String(row.lastUpdateTime) : null,
      };
    }

    if (/marketwatch/i.test(name) && Array.isArray(value)) {
      for (const row of value as Record<string, unknown>[]) {
        const symbol = String(row.symbol ?? row.Symbol ?? "").trim().toUpperCase();
        if (!symbol) continue;
        const last =
          toNum(row.lastTradePrice) ??
          toNum(row.lastPrice) ??
          toNum(row.LastPrice) ??
          toNum(row.closePrice);
        if (last == null || last <= 0) continue;
        outQuotes.push({
          symbol,
          lastTradePrice: last,
          closePrice: toNum(row.closePrice),
          openPrice: toNum(row.openPrice),
          highPrice: toNum(row.highPrice),
          lowPrice: toNum(row.lowPrice),
          netChange: toNum(row.netChange),
          netChangePerc: toNum(row.netChangePerc),
          bidPrice: toNum(row.bidPrice),
          offerPrice: toNum(row.offerPrice),
          totalVolume: toNum(row.totalVolume),
          totalValue: toNum(row.totalValue),
          companyName: row.companyE != null ? String(row.companyE) : row.symbolNameE != null ? String(row.symbolNameE) : null,
          companyNameAr: row.companyA != null ? String(row.companyA) : row.symbolNameA != null ? String(row.symbolNameA) : null,
          sector: row.sectorE != null ? String(row.sectorE) : row.sectorA != null ? String(row.sectorA) : null,
          updatedAt: String(row.updateDateTime ?? now),
        });
      }
    }

    if (/indici|index/i.test(name) && Array.isArray(value)) {
      for (const row of value as Record<string, unknown>[]) {
        const code = String(row.cI_SECTOR ?? row.CI_SECTOR ?? row.code ?? "").trim() || "IDX";
        const current = toNum(row.cI_CURRENT_INDEX) ?? toNum(row.currentValue);
        if (current == null) continue;
        outIndices.push({
          code,
          nameEn: String(row.ciE_DESC ?? row.exchangeNameE ?? code),
          nameAr: row.ciA_DESC != null ? String(row.ciA_DESC) : null,
          current,
          change: toNum(row.cI_CHG_INDEX),
          changePerc: toNum(row.cI_CHG_PERC_INDEX),
          high: toNum(row.cI_HIGH_INDEX),
          low: toNum(row.cI_LOW_INDEX),
          updatedAt: now,
        });
      }
    }
  }

  return { quotes: outQuotes, indices: outIndices, exchange: outExchange };
}

export function applyBroadcastPayload(payload: unknown): { quoteCount: number; indexCount: number } {
  const parsed = parseBroadcastPayload(payload);
  for (const q of parsed.quotes) quotes.set(q.symbol, q);
  for (const ix of parsed.indices) indices.set(ix.code, ix);
  if (parsed.exchange) exchangeSummary = parsed.exchange;
  lastMessageAt = new Date().toISOString();
  return { quoteCount: parsed.quotes.length, indexCount: parsed.indices.length };
}

export function getLiveQuotes(): LiveQuote[] {
  return [...quotes.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function getLiveIndices(): LiveIndex[] {
  return [...indices.values()].sort((a, b) => a.nameEn.localeCompare(b.nameEn));
}

export function getLiveExchangeSummary(): LiveExchangeSummary | null {
  return exchangeSummary;
}

/** Last trade prices by ticker for valuation (session). */
export function getLiveLastPriceMap(): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of quotes.values()) {
    if (q.lastTradePrice > 0) out.set(q.symbol, q.lastTradePrice);
  }
  return out;
}

export function getBroadcastStatus(env: NodeJS.ProcessEnv = process.env): BroadcastStatus {
  const configured = isBroadcastUrlConfigured(env);
  const hasQuotes = quotes.size > 0;
  const session = isBroadcastSessionOpen();
  return {
    configured,
    connected: connected || sampleLoaded,
    sampleLoaded,
    quoteCount: quotes.size,
    indexCount: indices.size,
    lastMessageAt,
    sessionOpen: session,
    ingestOfficialCloses: false,
    valuationSource: session && hasQuotes ? "last_price_session" : "official_close",
    objectsNamedByQsc: [...BROADCAST_OBJECT_NAMES],
    blockedReason: configured || sampleLoaded || hasQuotes ? null : "NO_BROADCAST_WS_URL",
    hubUrl: (env.BROADCAST_WS_URL || "").trim() || null,
    sessionHoursQatar: "08:00–15:00 Asia/Qatar",
    exchange: exchangeSummary,
  };
}

export function loadBroadcastSample(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = samplePath(env);
  if (!file) return false;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  applyBroadcastPayload(raw);
  sampleLoaded = true;
  console.log(`[live] Loaded broadcast sample (${quotes.size} quotes, ${indices.size} indices) from ${file}`);
  return true;
}

async function upsertClosePrices(asOf: string, priceByTicker: Map<string, number>): Promise<number> {
  if (priceByTicker.size === 0) return 0;
  const { db, schema } = await getDb();
  const tickers = [...priceByTicker.keys()];
  // Match both stored casing and uppercase feed symbols.
  const stockRows = await db.select({
    id: schema.stocks.id,
    ticker: schema.stocks.ticker,
  }).from(schema.stocks);

  let written = 0;
  for (const stock of stockRows) {
    const ticker = String(stock.ticker).trim().toUpperCase();
    if (!tickers.includes(ticker)) continue;
    const price = priceByTicker.get(ticker);
    if (price == null || price <= 0) continue;
    const existing = await db.select({ id: schema.stockPrices.id })
      .from(schema.stockPrices)
      .where(and(eq(schema.stockPrices.stockId, stock.id), eq(schema.stockPrices.date, asOf)))
      .limit(1);
    if (existing[0]) {
      await db.update(schema.stockPrices)
        .set({
          price: String(price),
          closePrice: String(price),
          sharePrice: String(price),
        })
        .where(eq(schema.stockPrices.id, existing[0].id));
    } else {
      await db.insert(schema.stockPrices).values({
        stockId: stock.id,
        date: asOf,
        price: String(price),
        closePrice: String(price),
        sharePrice: String(price),
      });
    }
    written += 1;
  }
  return written;
}

/** Persist in-memory Last Price as official close for the Qatar calendar day (س-25). */
export async function persistSessionCloses(asOf = todayQatarIso()): Promise<{ asOf: string; written: number }> {
  const written = await upsertClosePrices(asOf, getLiveLastPriceMap());
  console.log(`[live] Session close ingest asOf=${asOf} written=${written}`);
  return { asOf, written };
}

function connectWebSocket(url: string): void {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    // Node 22+ global WebSocket — works for raw ws:// / wss:// feeds.
    const socket = new WebSocket(url);
    ws = socket;
    socket.addEventListener("open", () => {
      connected = true;
      console.log(`[live] WebSocket connected ${url}`);
    });
    socket.addEventListener("message", (ev) => {
      try {
        const text = typeof ev.data === "string" ? ev.data : String(ev.data);
        const json = JSON.parse(text);
        applyBroadcastPayload(json);
      } catch (err) {
        console.warn("[live] bad broadcast message", err instanceof Error ? err.message : err);
      }
    });
    socket.addEventListener("close", () => {
      connected = false;
      console.log("[live] WebSocket closed — retry in 15s");
      setTimeout(() => {
        if (isBroadcastUrlConfigured() && isBroadcastSessionOpen()) connectWebSocket(url);
      }, 15_000);
    });
    socket.addEventListener("error", () => {
      connected = false;
    });
  } catch (err) {
    console.warn("[live] WebSocket connect failed", err instanceof Error ? err.message : err);
    connected = false;
  }
}

function startCloseCron(): void {
  if (closeCronStarted) return;
  closeCronStarted = true;
  // 15:05 Asia/Qatar — after meeting service window ends at 15:00
  cron.schedule("5 15 * * 0-4", () => {
    void persistSessionCloses().catch((err) => {
      console.error("[live] persistSessionCloses failed", err);
    });
  }, { timezone: "Asia/Qatar" });
}

export function startMarketBroadcast(): void {
  startCloseCron();
  const url = (process.env.BROADCAST_WS_URL || "").trim();
  const wantSample = process.env.BROADCAST_LOAD_SAMPLE !== "0";

  if (wantSample) loadBroadcastSample();

  if (url) {
    if (isBroadcastSessionOpen() || process.env.BROADCAST_CONNECT_ALWAYS === "1") {
      connectWebSocket(url);
    } else {
      console.log("[live] Hub URL set; waiting for Qatar session 08:00–15:00 to connect");
    }
    // Re-check session open every minute
    setInterval(() => {
      if (!url) return;
      if (isBroadcastSessionOpen() && !connected) connectWebSocket(url);
      if (!isBroadcastSessionOpen() && ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
        connected = false;
      }
    }, 60_000);
  } else {
    console.log("[live] No BROADCAST_WS_URL — using sample/in-memory quotes only; ticks never write stock_prices until session-end job");
  }

  const status = getBroadcastStatus();
  console.log(`[live] status connected=${status.connected} quotes=${status.quoteCount} valuation=${status.valuationSource}`);
}

export { todayQatarIso };
