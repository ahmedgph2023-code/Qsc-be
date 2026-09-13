import { getMssqlPool, sql } from "../db/mssql.js";
import { getPortfolioStatement, getRealizedSummaryStatement } from "./ext-sql-clients.js";
import { toNum } from "./ext-sql-portfolio.js";

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
};

export type FirmPortfolioStock = {
  ticker: string;
  companyName: string;
  securityNumber: number | null;
  clientCount: number;
  totalQuantity: number;
  totalCost: number;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  returnPct: number | null;
  realizedPl: number;
};

export type FirmPortfolioResult = {
  asOf: string;
  accountTypeFilter: string;
  clientCount: number;
  stocks: FirmPortfolioStock[];
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
      securityNumber: null,
      clientCount: new Set(list.map((r) => r.clientId)).size,
      totalQuantity,
      totalCost,
      marketPrice: prices.length === 1 ? prices[0]! : (list.find((r) => r.marketPrice != null)?.marketPrice ?? null),
      marketValue,
      unrealizedPl,
      returnPct: returnPctFromUnrealized(unrealizedPl, totalCost),
      realizedPl,
    });
  }
  stocks.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return stocks;
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
    holders,
    totals: {
      totalQuantity: stock.totalQuantity,
      totalCost: stock.totalCost,
      marketValue: stock.marketValue ?? 0,
      unrealizedPl: stock.unrealizedPl ?? 0,
      realizedPl: stock.realizedPl,
    },
  };
}
