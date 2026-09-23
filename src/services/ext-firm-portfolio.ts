import { getMssqlPool, sql } from "../db/mssql.js";
import { getPortfolioStatement, getRealizedSummaryStatement } from "./ext-sql-clients.js";
import { toNum } from "./ext-sql-portfolio.js";
import { formatDmY } from "./ext-invoice-report.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const roundPct = (n: number) => Math.round(n * 10000) / 10000;

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

export type FirmPortfolioHolder = {
  ticker: string;
  companyName: string;
  sector: string | null;
  clientId: number;
  clientName: string;
  nin: string;
  quantity: number;
  cost: number;
  costPrice: number;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  returnPct: number | null;
  realizedPl: number;
  /** Share of this stock's market value held by this client (drill-down only). */
  holderPct: number | null;
};

export type FirmPortfolioStock = {
  ticker: string;
  companyName: string;
  sector: string | null;
  securityNumber: number | null;
  clientCount: number;
  totalQuantity: number;
  totalCost: number;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  returnPct: number | null;
  realizedPl: number;
  /** Share of the firm's total market value held in this stock. */
  stockPct: number | null;
  /** Share of the firm's total market value held in this stock's sector. */
  sectorPct: number | null;
};

/** Sector rollup for the firm-level sector chart (percentages computed server-side). */
export type FirmPortfolioSector = {
  sector: string;
  stockCount: number;
  totalCost: number;
  marketValue: number | null;
  unrealizedPl: number | null;
  realizedPl: number;
  sectorPct: number | null;
};

export type FirmPortfolioResult = {
  asOf: string;
  accountTypeFilter: string;
  clientCount: number;
  stocks: FirmPortfolioStock[];
  sectors: FirmPortfolioSector[];
  totals: {
    totalQuantity: number;
    totalCost: number;
    marketValue: number;
    unrealizedPl: number;
    realizedPl: number;
  };
};

export type FirmPortfolioDrilldown = {
  asOf: string;
  ticker: string;
  companyName: string;
  sector: string | null;
  /** Latest market price used for this stock (3 dp on screen). */
  marketPrice: number | null;
  holders: FirmPortfolioHolder[];
  totals: {
    totalQuantity: number;
    totalCost: number;
    marketValue: number;
    unrealizedPl: number;
    realizedPl: number;
  };
};

export function returnPctFromUnrealized(unrealized: number | null, cost: number): number | null {
  if (unrealized == null || !(cost > 0)) return null;
  return roundPct((unrealized / cost) * 100);
}

async function listInvestmentClientIds(asOf: string, accountType = "INV PORT"): Promise<number[]> {
  const pool = await getMssqlPool();
  const req = pool.request();
  req.input("asOf", sql.Date, asOf);
  req.input("accountType", sql.NVarChar(64), accountType);

  const typed = await req.query(`
    SELECT DISTINCT st.ClientId
    FROM ShareTransactions st
    INNER JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(st.ClientId AS nvarchar(32))
    WHERE CAST(st.InvDate AS date) <= @asOf
      AND UPPER(LTRIM(RTRIM(ISNULL(i.CL_CLIENT_TYPE, '')))) LIKE '%' + UPPER(@accountType) + '%'
    ORDER BY st.ClientId
  `);
  let ids = (typed.recordset as Record<string, unknown>[]).map((r) => toNum(pick(r, "ClientId", "clientId"))).filter((n) => n > 0);
  if (ids.length > 0) return ids;

  // Fallback when CL_CLIENT_TYPE is not populated as INV PORT on SQL.
  const all = await pool.request().input("asOf", sql.Date, asOf).query(`
    SELECT DISTINCT ClientId
    FROM ShareTransactions
    WHERE CAST(InvDate AS date) <= @asOf
    ORDER BY ClientId
  `);
  ids = (all.recordset as Record<string, unknown>[]).map((r) => toNum(pick(r, "ClientId", "clientId"))).filter((n) => n > 0);
  return ids;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

type ClientSlice = {
  clientId: number;
  holders: FirmPortfolioHolder[];
};

async function loadClientSlice(clientId: number, asOf: string): Promise<ClientSlice | null> {
  const [portfolio, realized] = await Promise.all([
    getPortfolioStatement(clientId, asOf),
    getRealizedSummaryStatement(clientId, "2000-01-01", asOf),
  ]);
  if (!portfolio) return null;
  const realizedByTicker = new Map(
    (realized?.lines ?? []).map((l) => [l.ticker.trim().toUpperCase(), l.tradingProfit]),
  );
  const holders: FirmPortfolioHolder[] = [];
  for (const sector of portfolio.sectors) {
    for (const line of sector.lines) {
      if (!(line.quantity > 0)) continue;
      const ticker = line.ticker.trim();
      const unrealized = line.displayedProfit.value ?? line.unrealizedGross;
      const cost = line.costValue;
      holders.push({
        ticker,
        companyName: line.companyName,
        sector: line.sectorName?.trim() || sector.sectorName?.trim() || null,
        clientId,
        clientName: portfolio.investor.displayName,
        nin: portfolio.investor.nin,
        quantity: line.quantity,
        cost: round4(cost),
        costPrice: round4(line.shareCost),
        marketPrice: line.closePrice,
        marketValue: line.marketValue == null ? null : round4(line.marketValue),
        unrealizedPl: unrealized == null ? null : round4(unrealized),
        returnPct: returnPctFromUnrealized(unrealized, cost),
        realizedPl: round4(realizedByTicker.get(ticker.toUpperCase()) ?? 0),
        holderPct: null,
      });
    }
  }
  return { clientId, holders };
}

export function aggregateFirmHolders(holders: FirmPortfolioHolder[]): FirmPortfolioStock[] {
  const byTicker = new Map<string, FirmPortfolioHolder[]>();
  for (const h of holders) {
    const key = h.ticker.toUpperCase();
    const list = byTicker.get(key) ?? [];
    list.push(h);
    byTicker.set(key, list);
  }
  const stocks: FirmPortfolioStock[] = [];
  for (const [, list] of byTicker) {
    const first = list[0]!;
    const totalQuantity = round4(list.reduce((s, r) => s + r.quantity, 0));
    const totalCost = round4(list.reduce((s, r) => s + r.cost, 0));
    const marketValueParts = list.map((r) => r.marketValue);
    const marketValue = marketValueParts.every((v) => v != null)
      ? round4(marketValueParts.reduce((s, v) => s + (v as number), 0))
      : null;
    const unrealizedParts = list.map((r) => r.unrealizedPl);
    const unrealizedPl = unrealizedParts.every((v) => v != null)
      ? round4(unrealizedParts.reduce((s, v) => s + (v as number), 0))
      : null;
    const realizedPl = round4(list.reduce((s, r) => s + r.realizedPl, 0));
    const prices = [...new Set(list.map((r) => r.marketPrice).filter((p): p is number => p != null && p > 0))];
    stocks.push({
      ticker: first.ticker,
      companyName: first.companyName,
      sector: list.find((r) => r.sector)?.sector ?? null,
      securityNumber: null,
      clientCount: new Set(list.map((r) => r.clientId)).size,
      totalQuantity,
      totalCost,
      marketPrice: prices.length === 1 ? prices[0]! : (list.find((r) => r.marketPrice != null)?.marketPrice ?? null),
      marketValue,
      unrealizedPl,
      returnPct: returnPctFromUnrealized(unrealizedPl, totalCost),
      realizedPl,
      stockPct: null,
      sectorPct: null,
    });
  }
  stocks.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return withFirmWeights(stocks);
}

const UNCLASSIFIED_SECTOR = "Unclassified";

function share(part: number | null, whole: number): number | null {
  if (part == null || !(whole > 0)) return null;
  return roundPct((part / whole) * 100);
}

/**
 * Stock % and sector % of the firm's total market value. Weights live here, not
 * in the UI, so the table, the charts and the exports always agree.
 */
export function withFirmWeights(stocks: FirmPortfolioStock[]): FirmPortfolioStock[] {
  const firmMarketValue = stocks.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const bySector = new Map<string, number>();
  for (const stock of stocks) {
    const key = stock.sector?.trim() || UNCLASSIFIED_SECTOR;
    bySector.set(key, (bySector.get(key) ?? 0) + (stock.marketValue ?? 0));
  }
  return stocks.map((stock) => ({
    ...stock,
    stockPct: share(stock.marketValue, firmMarketValue),
    sectorPct: share(bySector.get(stock.sector?.trim() || UNCLASSIFIED_SECTOR) ?? null, firmMarketValue),
  }));
}

/** Holder shares of one stock, for the holders chart in the drill-down. */
export function withHolderWeights(holders: FirmPortfolioHolder[]): FirmPortfolioHolder[] {
  const stockMarketValue = holders.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  return holders.map((holder) => ({ ...holder, holderPct: share(holder.marketValue, stockMarketValue) }));
}

/** Sector rollup used by the firm sector chart and the sector rows in exports. */
export function aggregateFirmSectors(stocks: FirmPortfolioStock[]): FirmPortfolioSector[] {
  const firmMarketValue = stocks.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const groups = new Map<string, FirmPortfolioStock[]>();
  for (const stock of stocks) {
    const key = stock.sector?.trim() || UNCLASSIFIED_SECTOR;
    const list = groups.get(key) ?? [];
    list.push(stock);
    groups.set(key, list);
  }
  const sectors: FirmPortfolioSector[] = [];
  for (const [sector, list] of groups) {
    const marketValue = list.every((s) => s.marketValue != null)
      ? round4(list.reduce((s, r) => s + (r.marketValue ?? 0), 0))
      : null;
    const unrealizedPl = list.every((s) => s.unrealizedPl != null)
      ? round4(list.reduce((s, r) => s + (r.unrealizedPl ?? 0), 0))
      : null;
    sectors.push({
      sector,
      stockCount: list.length,
      totalCost: round4(list.reduce((s, r) => s + r.totalCost, 0)),
      marketValue,
      unrealizedPl,
      realizedPl: round4(list.reduce((s, r) => s + r.realizedPl, 0)),
      sectorPct: share(list.reduce((s, r) => s + (r.marketValue ?? 0), 0), firmMarketValue),
    });
  }
  sectors.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0) || a.sector.localeCompare(b.sector));
  return sectors;
}

const price3 = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Header lines printed on the firm portfolio Excel and PDF exports. */
export function firmPortfolioHeaderLines(report: FirmPortfolioResult): Array<{ label: string; value: string }> {
  return [
    { label: "As of", value: formatDmY(report.asOf) },
    { label: "Account Type", value: report.accountTypeFilter },
    { label: "Clients", value: String(report.clientCount) },
    { label: "Stocks", value: String(report.stocks.length) },
  ];
}

/** Header lines printed on the stock-holders Excel and PDF exports. */
export function firmHoldersHeaderLines(drill: FirmPortfolioDrilldown): Array<{ label: string; value: string }> {
  return [
    { label: "Stock", value: `${drill.ticker} — ${drill.companyName}` },
    { label: "Sector", value: drill.sector || "Unclassified" },
    { label: "Market Price", value: price3(drill.marketPrice) },
    { label: "As of", value: formatDmY(drill.asOf) },
    { label: "Holders", value: String(drill.holders.length) },
  ];
}

export function sumFirmStocks(stocks: FirmPortfolioStock[]) {
  return {
    totalQuantity: round4(stocks.reduce((s, r) => s + r.totalQuantity, 0)),
    totalCost: round4(stocks.reduce((s, r) => s + r.totalCost, 0)),
    marketValue: round4(stocks.reduce((s, r) => s + (r.marketValue ?? 0), 0)),
    unrealizedPl: round4(stocks.reduce((s, r) => s + (r.unrealizedPl ?? 0), 0)),
    realizedPl: round4(stocks.reduce((s, r) => s + r.realizedPl, 0)),
  };
}

export async function getFirmInvestmentPortfolio(asOf: string): Promise<FirmPortfolioResult> {
  const clientIds = await listInvestmentClientIds(asOf);
  const slices = (await mapPool(clientIds, 4, (id) => loadClientSlice(id, asOf))).filter(
    (s): s is ClientSlice => s != null,
  );
  const holders = slices.flatMap((s) => s.holders);
  const stocks = aggregateFirmHolders(holders);
  return {
    asOf,
    accountTypeFilter: "INV PORT",
    clientCount: slices.length,
    stocks,
    sectors: aggregateFirmSectors(stocks),
    totals: sumFirmStocks(stocks),
  };
}

export async function getFirmInvestmentPortfolioDrilldown(
  asOf: string,
  ticker: string,
): Promise<FirmPortfolioDrilldown | null> {
  const want = ticker.trim().toUpperCase();
  if (!want) return null;
  const clientIds = await listInvestmentClientIds(asOf);
  const slices = (await mapPool(clientIds, 4, (id) => loadClientSlice(id, asOf))).filter(
    (s): s is ClientSlice => s != null,
  );
  const holders = slices
    .flatMap((s) => s.holders)
    .filter((h) => h.ticker.toUpperCase() === want)
    .sort((a, b) => a.clientId - b.clientId);
  if (holders.length === 0) return null;
  const stocks = aggregateFirmHolders(holders);
  const stock = stocks[0]!;
  return {
    asOf,
    ticker: stock.ticker,
    companyName: stock.companyName,
    sector: stock.sector,
    marketPrice: stock.marketPrice,
    holders: withHolderWeights(holders),
    totals: {
      totalQuantity: stock.totalQuantity,
      totalCost: stock.totalCost,
      marketValue: stock.marketValue ?? 0,
      unrealizedPl: stock.unrealizedPl ?? 0,
      realizedPl: stock.realizedPl,
    },
  };
}
