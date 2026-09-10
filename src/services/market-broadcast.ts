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
  bidVolume: number | null;
  offerVolume: number | null;
  lastTradeVolume: number | null;
  trades: number | null;
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
  symbolsTraded: number | null;
  totalExecuted: number | null;
  lastUpdateTime: string | null;
};

type FeedSource = "hub" | "qse_public" | "sample" | "none";

type BroadcastStatus = {
  configured: boolean;
  connected: boolean;
  sampleLoaded: boolean;
  feedSource: FeedSource;
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
  /** Asia/Qatar clock when Last Price is saved as official close. */
  closeSaveHour: number;
  closeSaveMinute: number;
  closeSaveLabel: string;
};

export type LiveCloseSaveConfig = {
  hour: number;
  minute: number;
};

const quotes = new Map<string, LiveQuote>();
const indices = new Map<string, LiveIndex>();
let exchangeSummary: LiveExchangeSummary | null = null;
let lastMessageAt: string | null = null;
let connected = false;
let sampleLoaded = false;
let feedSource: FeedSource = "none";
let ws: WebSocket | null = null;
let closeCronTask: ReturnType<typeof cron.schedule> | null = null;
let closeSaveConfig: LiveCloseSaveConfig = { hour: 15, minute: 5 };
let qsePollTimer: ReturnType<typeof setInterval> | null = null;

const QSE_MW_URLS = [
  "https://www.qe.com.qa/wp/mw/bg/mw.php",
  "https://www.qe.com.qa/wp/mw_app/mw.php",
] as const;

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** OHLC often arrives as 0 before the session prints a real open — treat as missing. */
function toSessionPrice(v: unknown): number | null {
  const n = toNum(v);
  if (n == null || n <= 0) return null;
  return n;
}

function asText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.includes("\uFFFD")) return null;
  return s;
}

function pickCompanyNameEn(row: Record<string, unknown>): string | null {
  return (
    asText(row.companyE) ??
    asText(row.symbolNameE) ??
    asText(row.symbolNameEnglish) ??
    null
  );
}

function pickCompanyNameAr(row: Record<string, unknown>): string | null {
  return (
    asText(row.symbolNameArabic) ??
    asText(row.companyA) ??
    asText(row.symbolNameA) ??
    null
  );
}

/** Client: Symbol With Icon (Object 2) — e.g. DHBK. */
function pickSymbol(row: Record<string, unknown>): string {
  const raw = String(row.symbolWithIcon ?? row.SymbolWithIcon ?? row.symbol ?? row.Symbol ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/[A-Za-z]{2,12}/);
  return (m?.[0] ?? raw).toUpperCase();
}

/** Meeting sample was saved as Windows-1256 bytes inside a JSON shell — recover UTF-8. */
export function parseBroadcastJsonText(buf: Buffer): unknown {
  const asUtf8 = buf.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) return JSON.parse(asUtf8);
  return JSON.parse(new TextDecoder("windows-1256").decode(buf));
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
        nameAr: asText(row.exchangeNameA) ?? asText(row.m_NAME),
        currentValue: toNum(row.currentValue),
        netChange: toNum(row.netChange),
        netChangePerc: toNum(row.netChangePerc),
        volume: toNum(row.volume),
        turnOver: toNum(row.turnOver),
        symbolsUp: toNum(row.symbolsUP),
        symbolsDown: toNum(row.symbolsDown),
        symbolsUnchanged: toNum(row.symbolsUnChange),
        symbolsTraded: toNum(row.symbolsTraded),
        totalExecuted: toNum(row.totalExecuted),
        lastUpdateTime: row.lastUpdateTime != null ? String(row.lastUpdateTime) : null,
      };
    }

    if (/marketwatch/i.test(name) && Array.isArray(value)) {
      for (const row of value as Record<string, unknown>[]) {
        const symbol = pickSymbol(row);
        if (!symbol) continue;
        const last =
          toNum(row.lastTradePrice) ??
          toNum(row.lastPrice) ??
          toNum(row.LastPrice) ??
          toNum(row.closePrice);
        if (last == null || last <= 0) continue;
        const closePrice = toNum(row.closePrice);
        const netChange =
          toNum(row.netChange) ??
          toNum(row.change) ??
          (closePrice != null ? Math.round((last - closePrice) * 10000) / 10000 : null);
        const netChangePerc =
          toNum(row.netChangePerc) ??
          toNum(row.changePerc) ??
          (closePrice != null && closePrice > 0 && netChange != null
            ? Math.round((netChange / closePrice) * 10000) / 100
            : null);
        outQuotes.push({
          symbol,
          lastTradePrice: last,
          closePrice,
          openPrice: toSessionPrice(row.openPrice),
          highPrice: toSessionPrice(row.highPrice),
          lowPrice: toSessionPrice(row.lowPrice),
          netChange,
          netChangePerc,
          bidPrice: toNum(row.bidPrice),
          offerPrice: toNum(row.offerPrice),
          bidVolume: toNum(row.bidVolume) ?? toNum(row.totalBidVolume),
          offerVolume: toNum(row.offerVolume) ?? toNum(row.totalOfferVolume),
          lastTradeVolume: toNum(row.lastTradeVolume),
          trades: toNum(row.executed),
          totalVolume: toNum(row.totalVolume),
          totalValue: toNum(row.totalValue),
          companyName: pickCompanyNameEn(row),
          companyNameAr: pickCompanyNameAr(row),
          sector: asText(row.sectorE) ?? asText(row.sectorA),
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
          nameAr: asText(row.ciA_DESC),
          current,
          change: toNum(row.cI_CHG_INDEX),
          changePerc: toNum(row.cI_CHG_PERC_INDEX),
          high: toSessionPrice(row.cI_HIGH_INDEX),
          low: toSessionPrice(row.cI_LOW_INDEX),
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
  if (feedSource === "none") feedSource = "hub";
  return { quoteCount: parsed.quotes.length, indexCount: parsed.indices.length };
}

/** Map public QSE Market Watch row (mw.php) → LiveQuote. */
export function mapQsePublicWatchRow(row: Record<string, unknown>, now = new Date().toISOString()): LiveQuote | null {
  const symbol = pickSymbol({
    symbolWithIcon: row.Symbol ?? row.symbol,
    symbol: row.Symbol ?? row.symbol,
  });
  if (!symbol) return null;
  const last =
    toNum(row.LastPrice) ??
    toNum(row.lastTradePrice) ??
    toNum(row.lastPrice);
  if (last == null || last <= 0) return null;
  const closePrice =
    toNum(row.PrevClosing) ??
    toNum(row.prevClosing) ??
    toNum(row.closePrice);
  const netChange =
    toNum(row.Change) ??
    toNum(row.netChange) ??
    (closePrice != null ? Math.round((last - closePrice) * 10000) / 10000 : null);
  const netChangePerc =
    toNum(row.PercentChange) ??
    toNum(row.netChangePerc) ??
    (closePrice != null && closePrice > 0 && netChange != null
      ? Math.round((netChange / closePrice) * 10000) / 100
      : null);
  return {
    symbol,
    lastTradePrice: last,
    closePrice,
    openPrice: toSessionPrice(row.OpenPrice ?? row.openPrice),
    highPrice: toSessionPrice(row.High ?? row.highPrice),
    lowPrice: toSessionPrice(row.Low ?? row.lowPrice),
    netChange,
    netChangePerc,
    bidPrice: toNum(row.BidPrice ?? row.bidPrice),
    offerPrice: toNum(row.OfferPrice ?? row.offerPrice),
    bidVolume: toNum(row.BidVolume ?? row.bidVolume),
    offerVolume: toNum(row.OfferVolume ?? row.offerVolume),
    lastTradeVolume: toNum(row.lastTradeVolume),
    trades: toNum(row.Trades ?? row.executed),
    totalVolume: toNum(row.Volume ?? row.totalVolume),
    totalValue: toNum(row.Value ?? row.totalValue),
    companyName: asText(row.CompanyEN) ?? pickCompanyNameEn(row),
    companyNameAr: asText(row.CompanyAR) ?? pickCompanyNameAr(row),
    sector: asText(row.SectorEN) ?? asText(row.SectorAR) ?? asText(row.sectorE),
    updatedAt: now,
  };
}

function exchangeFromQuotes(list: LiveQuote[]): LiveExchangeSummary {
  let up = 0;
  let down = 0;
  let flat = 0;
  let volume = 0;
  let turnOver = 0;
  let totalExecuted = 0;
  let traded = 0;
  for (const q of list) {
    const dir =
      q.closePrice != null && Number.isFinite(q.closePrice)
        ? q.lastTradePrice - q.closePrice
        : q.netChange ?? 0;
    if (Math.abs(dir) < 1e-9) flat += 1;
    else if (dir > 0) up += 1;
    else down += 1;
    if ((q.totalVolume ?? 0) > 0 || (q.trades ?? 0) > 0) traded += 1;
    volume += q.totalVolume ?? 0;
    turnOver += q.totalValue ?? 0;
    totalExecuted += q.trades ?? 0;
  }
  return {
    exchangeId: "QE",
    nameEn: "Qatar Stock Exchange",
    nameAr: "سوق قطر",
    currentValue: null,
    netChange: null,
    netChangePerc: null,
    volume,
    turnOver,
    symbolsUp: up,
    symbolsDown: down,
    symbolsUnchanged: flat,
    symbolsTraded: traded,
    totalExecuted,
    lastUpdateTime: new Date().toISOString(),
  };
}

function applyQsePublicWatch(rows: Record<string, unknown>[]): number {
  const now = new Date().toISOString();
  const mapped: LiveQuote[] = [];
  for (const row of rows) {
    const q = mapQsePublicWatchRow(row, now);
    if (!q) continue;
    quotes.set(q.symbol, q);
    mapped.push(q);
  }
  if (mapped.length === 0) return 0;
  exchangeSummary = {
    ...exchangeFromQuotes(mapped),
    currentValue: exchangeSummary?.currentValue ?? null,
    netChange: exchangeSummary?.netChange ?? null,
    netChangePerc: exchangeSummary?.netChangePerc ?? null,
  };
  lastMessageAt = now;
  sampleLoaded = false;
  feedSource = "qse_public";
  connected = true;
  return mapped.length;
}

async function postQseMw(url: string, form: string, timeoutMs = 25_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        origin: "https://www.qe.com.qa",
        referer: "https://www.qe.com.qa/wp/mws/market/main",
      },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (process.platform === "win32") {
      return postQseMwViaPowershell(url, form, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Some Windows/Node TLS stacks reset on qe.com.qa; PowerShell often succeeds. */
async function postQseMwViaPowershell(url: string, form: string, timeoutMs: number): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const ps = `
$ErrorActionPreference = 'Stop'
$r = Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -Method POST -Body '${form.replace(/'/g, "''")}' -ContentType 'application/x-www-form-urlencoded' -Headers @{ 'User-Agent'='Mozilla/5.0'; Referer='https://www.qe.com.qa/wp/mws/market/main'; Origin='https://www.qe.com.qa' } -UseBasicParsing -TimeoutSec ${Math.max(5, Math.ceil(timeoutMs / 1000))}
$r.Content
`.trim();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { timeout: timeoutMs + 5_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
  );
  return JSON.parse(String(stdout));
}

/** Public QSE Market Watch snapshot used by qe.com.qa (fallback when Hub URL is missing). */
export async function refreshFromQsePublicWebsite(): Promise<{ ok: boolean; quoteCount: number; error?: string }> {
  if (process.env.BROADCAST_QSE_PUBLIC === "0") {
    return { ok: false, quoteCount: 0, error: "DISABLED" };
  }
  let lastErr = "NO_ENDPOINT";
  for (const url of QSE_MW_URLS) {
    try {
      const json = (await postQseMw(url, "f=MarketWatch")) as Record<string, unknown>;
      const rows = Array.isArray(json.rows) ? (json.rows as Record<string, unknown>[]) : [];
      const n = applyQsePublicWatch(rows);
      if (n <= 0) {
        lastErr = "EMPTY_ROWS";
        continue;
      }
      // Best-effort indices / index level (ignore failures).
      try {
        const ixJson = (await postQseMw(url, "f=Indices")) as Record<string, unknown>;
        const ixRows = Array.isArray(ixJson.rows) ? (ixJson.rows as Record<string, unknown>[]) : [];
        const now = new Date().toISOString();
        for (const row of ixRows) {
          const code = String(row.IndexCode ?? row.Code ?? row.code ?? "").trim() || "IDX";
          const current = toNum(row.Value ?? row.Current ?? row.currentValue ?? row.Last);
          if (current == null) continue;
          indices.set(code, {
            code,
            nameEn: String(row.NameEN ?? row.IndexNameEN ?? row.nameEn ?? code),
            nameAr: asText(row.NameAR ?? row.IndexNameAR),
            current,
            change: toNum(row.Change ?? row.netChange),
            changePerc: toNum(row.PercentChange ?? row.netChangePerc),
            high: toSessionPrice(row.High),
            low: toSessionPrice(row.Low),
            updatedAt: now,
          });
        }
      } catch {
        /* optional */
      }
      try {
        const idx = (await postQseMw(url, "f=Index")) as Record<string, unknown>;
        const row = (Array.isArray(idx.rows) ? idx.rows[0] : idx) as Record<string, unknown> | undefined;
        if (row && exchangeSummary) {
          exchangeSummary = {
            ...exchangeSummary,
            currentValue: toNum(row.Value ?? row.Current ?? row.currentValue) ?? exchangeSummary.currentValue,
            netChange: toNum(row.Change ?? row.netChange) ?? exchangeSummary.netChange,
            netChangePerc: toNum(row.PercentChange ?? row.netChangePerc) ?? exchangeSummary.netChangePerc,
            nameEn: asText(row.NameEN ?? row.nameEn) ?? exchangeSummary.nameEn,
            nameAr: asText(row.NameAR) ?? exchangeSummary.nameAr,
          };
        }
      } catch {
        /* optional */
      }
      console.log(`[live] QSE public Market Watch ok via ${url} (${n} quotes)`);
      return { ok: true, quoteCount: n };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[live] QSE public fetch failed ${url}: ${lastErr}`);
    }
  }
  return { ok: false, quoteCount: 0, error: lastErr };
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
  const close = getCloseSaveConfig();
  const liveFeed = feedSource === "hub" || feedSource === "qse_public";
  return {
    configured,
    connected: liveFeed && (connected || hasQuotes),
    sampleLoaded,
    feedSource,
    quoteCount: quotes.size,
    indexCount: indices.size,
    lastMessageAt,
    sessionOpen: session,
    ingestOfficialCloses: false,
    valuationSource: session && hasQuotes ? "last_price_session" : "official_close",
    objectsNamedByQsc: [...BROADCAST_OBJECT_NAMES],
    blockedReason: configured || hasQuotes ? null : "NO_BROADCAST_WS_URL",
    hubUrl: (env.BROADCAST_WS_URL || "").trim() || null,
    sessionHoursQatar: "08:00–15:00 Asia/Qatar",
    exchange: exchangeSummary,
    closeSaveHour: close.hour,
    closeSaveMinute: close.minute,
    closeSaveLabel: `${String(close.hour).padStart(2, "0")}:${String(close.minute).padStart(2, "0")} Asia/Qatar`,
  };
}

export function loadBroadcastSample(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = samplePath(env);
  if (!file) return false;
  const raw = parseBroadcastJsonText(fs.readFileSync(file));
  applyBroadcastPayload(raw);
  sampleLoaded = true;
  feedSource = "sample";
  connected = false;
  console.log(`[live] Loaded broadcast sample (${quotes.size} quotes, ${indices.size} indices) from ${file}`);
  return true;
}

function closeConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../.data/live-close-config.json");
}

function clampHour(n: number): number {
  if (!Number.isFinite(n)) return 15;
  return Math.min(23, Math.max(0, Math.trunc(n)));
}

function clampMinute(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(59, Math.max(0, Math.trunc(n)));
}

function readCloseConfigFromDisk(): LiveCloseSaveConfig | null {
  try {
    const file = closeConfigPath();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LiveCloseSaveConfig>;
    return { hour: clampHour(Number(raw.hour)), minute: clampMinute(Number(raw.minute)) };
  } catch {
    return null;
  }
}

function envCloseConfig(env: NodeJS.ProcessEnv = process.env): LiveCloseSaveConfig {
  const hhmm = (env.BROADCAST_CLOSE_HHMM || "").trim();
  if (/^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(":").map(Number);
    return { hour: clampHour(h!), minute: clampMinute(m!) };
  }
  return {
    hour: clampHour(Number(env.BROADCAST_CLOSE_HOUR ?? 15)),
    minute: clampMinute(Number(env.BROADCAST_CLOSE_MINUTE ?? 5)),
  };
}

export function getCloseSaveConfig(): LiveCloseSaveConfig {
  return { ...closeSaveConfig };
}

export function setCloseSaveConfig(input: { hour: number; minute?: number }): LiveCloseSaveConfig {
  closeSaveConfig = {
    hour: clampHour(input.hour),
    minute: clampMinute(input.minute ?? closeSaveConfig.minute),
  };
  try {
    const file = closeConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(closeSaveConfig, null, 2), "utf8");
  } catch (err) {
    console.warn("[live] could not persist close-save config", err instanceof Error ? err.message : err);
  }
  startCloseCron();
  return getCloseSaveConfig();
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

/**
 * QA helper: nudge a few Last Prices so the UI can prove live flash updates
 * without the real Hub URL. Does not write stock_prices.
 */
export function simulateLiveTicks(count = 8): { touched: string[] } {
  const list = [...quotes.values()];
  if (list.length === 0) return { touched: [] };
  const n = Math.max(1, Math.min(count, list.length));
  const touched: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * list.length);
    const q = list[idx]!;
    const delta = (Math.random() > 0.5 ? 1 : -1) * (0.001 + Math.random() * 0.02);
    const next = Math.max(0.001, Math.round((q.lastTradePrice + delta) * 1000) / 1000);
    const close = q.closePrice ?? q.lastTradePrice;
    const netChange = Math.round((next - close) * 1000) / 1000;
    const netChangePerc = close > 0 ? Math.round((netChange / close) * 10000) / 100 : null;
    quotes.set(q.symbol, {
      ...q,
      lastTradePrice: next,
      netChange,
      netChangePerc,
      updatedAt: new Date().toISOString(),
    });
    touched.push(q.symbol);
  }
  lastMessageAt = new Date().toISOString();
  sampleLoaded = true;
  return { touched: [...new Set(touched)] };
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
      feedSource = "hub";
      sampleLoaded = false;
      console.log(`[live] WebSocket connected ${url}`);
    });
    socket.addEventListener("message", (ev) => {
      try {
        const text = typeof ev.data === "string" ? ev.data : String(ev.data);
        const json = JSON.parse(text);
        applyBroadcastPayload(json);
        feedSource = "hub";
        sampleLoaded = false;
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
  try {
    closeCronTask?.stop();
  } catch {
    /* ignore */
  }
  const { hour, minute } = closeSaveConfig;
  closeCronTask = cron.schedule(`${minute} ${hour} * * 0-4`, () => {
    void persistSessionCloses().catch((err) => {
      console.error("[live] persistSessionCloses failed", err);
    });
  }, { timezone: "Asia/Qatar" });
  console.log(`[live] Close-save cron set for ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} Asia/Qatar (Sun–Thu)`);
}

export function startMarketBroadcast(): void {
  closeSaveConfig = readCloseConfigFromDisk() ?? envCloseConfig();
  startCloseCron();
  const url = (process.env.BROADCAST_WS_URL || "").trim();
  const wantSample = process.env.BROADCAST_LOAD_SAMPLE !== "0";
  const wantQsePublic = process.env.BROADCAST_QSE_PUBLIC !== "0";

  if (url) {
    if (wantSample) loadBroadcastSample();
    if (isBroadcastSessionOpen() || process.env.BROADCAST_CONNECT_ALWAYS === "1") {
      connectWebSocket(url);
    } else {
      console.log("[live] Hub URL set; waiting for Qatar session 08:00–15:00 to connect");
    }
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
    console.log("[live] No BROADCAST_WS_URL — trying QSE public Market Watch, then BroadcastData sample");
    const startFallback = async () => {
      if (wantQsePublic) {
        const qse = await refreshFromQsePublicWebsite();
        if (qse.ok) {
          const pollMs = Math.max(5_000, Number(process.env.BROADCAST_QSE_POLL_MS || 15_000) || 15_000);
          if (qsePollTimer) clearInterval(qsePollTimer);
          qsePollTimer = setInterval(() => {
            if (ws && connected) return;
            void refreshFromQsePublicWebsite().catch((err) => {
              console.warn("[live] QSE public poll error", err instanceof Error ? err.message : err);
            });
          }, pollMs);
          console.log(`[live] QSE public poll every ${pollMs}ms (BROADCAST_QSE_PUBLIC=0 to disable)`);
          return;
        }
        console.warn(`[live] QSE public unavailable (${qse.error ?? "unknown"}) — falling back to sample`);
      }
      if (wantSample) {
        loadBroadcastSample();
        if (process.env.BROADCAST_SAMPLE_AUTO_TICK !== "0") {
          setInterval(() => {
            if (quotes.size === 0) return;
            if (feedSource === "hub" || feedSource === "qse_public") return;
            if (ws && connected) return;
            simulateLiveTicks(8);
          }, 2_000);
          console.log("[live] Sample auto-tick every 2s (set BROADCAST_SAMPLE_AUTO_TICK=0 to disable)");
        }
      }
    };
    void startFallback();
  }

  const status = getBroadcastStatus();
  console.log(`[live] status connected=${status.connected} feed=${status.feedSource} quotes=${status.quoteCount} valuation=${status.valuationSource} closeSave=${status.closeSaveLabel}`);
}

export { todayQatarIso };
