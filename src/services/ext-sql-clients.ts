import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { getMssqlPool, sql } from "../db/mssql.js";
import { indexLevelReturn } from "./excel-workbook-engine.js";
import {
  buildExtHoldings,
  buildExtWorkbook,
  cashBalance,
  cashRowsThrough,
  eventsFromShares,
  firstActivityDate,
  investorDisplayName,
  navAllocation,
  realizedFromEvents,
  textOrEmpty,
  toNum,
  toYmd,
  unitPriceFromShare,
  type ExtCashRow,
  type ExtShareRow,
} from "./ext-sql-portfolio.js";
import { portfolioStatementFromLedgers } from "./statement-portfolio.js";
import { assembleAccountStatement } from "./statement-account.js";
import { assembleRealizedDetails } from "./realized-blotter.js";
import { assembleRealizedSummary } from "./realized-summary.js";
import { applySampleInvestorKbHeader, buildInvestorHeader } from "./statement-types.js";
import { paginateMeta } from "../utils/params.js";

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function mapShare(row: Record<string, unknown>): ExtShareRow {
  const ticker = String(pick(row, "TickerId", "tickerId") ?? "").trim();
  const long = String(pick(row, "SceLongName", "sceLongName", "ScaLongName", "scaLongName") ?? "").trim();
  const short = String(pick(row, "SceShortName", "sceShortName", "ScaShortName", "scaShortName") ?? "").trim();
  return {
    id: toNum(pick(row, "Id", "id")),
    tickerId: ticker,
    companyName: long || short || ticker,
    invType: String(pick(row, "InvType", "invType") ?? ""),
    invDate: toYmd(pick(row, "InvDate", "invDate")),
    buySellFlag: String(pick(row, "BuySellFlag", "buySellFlag") ?? ""),
    nin: String(pick(row, "Nin", "nin") ?? "").trim(),
    clientId: toNum(pick(row, "ClientId", "clientId")),
    qty: toNum(pick(row, "Qty", "qty")),
    avgPrice: toNum(pick(row, "AvgPrice", "avgPrice")),
    total: toNum(pick(row, "Total", "total")),
    net: toNum(pick(row, "Net", "net")),
    totalComm: toNum(pick(row, "TotalComm", "totalComm")),
    invNo: pick(row, "InvNo", "invNo") == null ? null : toNum(pick(row, "InvNo", "invNo")),
    compId: pick(row, "CompId", "compId") == null || pick(row, "CompId", "compId") === ""
      ? null
      : toNum(pick(row, "CompId", "compId")),
    officeComm: toNum(pick(row, "OfficeComm", "officeComm")),
    marketComm: toNum(pick(row, "MarketComm", "marketComm")),
    originalPrice: toNum(pick(row, "OriginalPrice", "originalPrice")),
  };
}

function mapCash(row: Record<string, unknown>): ExtCashRow {
  const main = pick(row, "MainObjCode", "mainObjCode");
  const invoiceRaw = pick(row, "InvoiceNo", "InvoiceNumber", "invoiceNo", "InvNo", "invNo");
  const invoiceTypeRaw = pick(row, "InvoiceType", "invoiceType", "InvType", "invType");
  return {
    id: toNum(pick(row, "Id", "id")),
    docCode: String(pick(row, "DocCode", "docCode") ?? ""),
    docNo: pick(row, "DocNo", "docNo") == null ? null : toNum(pick(row, "DocNo", "docNo")),
    serNo: pick(row, "SerNo", "serNo") == null ? null : toNum(pick(row, "SerNo", "serNo")),
    nin: String(pick(row, "Nin", "nin") ?? "").trim(),
    mainObjCode: main == null ? null : String(main),
    objCode: toNum(pick(row, "ObjCode", "objCode")),
    dbAmt: toNum(pick(row, "DbAmt", "dbAmt")),
    crAmt: toNum(pick(row, "CrAmt", "crAmt")),
    remarks: pick(row, "Remarks", "remarks") == null ? null : String(pick(row, "Remarks", "remarks")),
    eRemarks: pick(row, "ERemarks", "eRemarks") == null ? null : String(pick(row, "ERemarks", "eRemarks")),
    docDate: toYmd(pick(row, "DocDate", "docDate")),
    postDate: toYmd(pick(row, "PostDate", "postDate")),
    docAmt: toNum(pick(row, "DocAmt", "docAmt")),
    status: String(pick(row, "Status", "status") ?? ""),
    invoiceNo: invoiceRaw == null || invoiceRaw === "" ? null : toNum(invoiceRaw),
    invoiceType: invoiceTypeRaw == null || invoiceTypeRaw === ""
      ? null
      : String(invoiceTypeRaw).trim(),
  };
}

async function queryRows(text: string, bind?: (req: sql.Request) => void): Promise<Record<string, unknown>[]> {
  const pool = await getMssqlPool();
  const req = pool.request();
  bind?.(req);
  const result = await req.query(text);
  return result.recordset as Record<string, unknown>[];
}

export async function loadShares(clientId: number, asOf?: string): Promise<ExtShareRow[]> {
  const rows = await queryRows(
    `
    SELECT Id, CompId, TickerId, ScaLongName, SceLongName, ScaShortName, SceShortName,
           InvNo, InvType, InvDate, BuySellFlag, Nin, ClientId,
           Qty, AvgPrice, Total, Net, TotalComm, OfficeComm, MarketComm, OriginalPrice
    FROM ShareTransactions
    WHERE ClientId = @clientId
      AND (@asOf IS NULL OR CAST(InvDate AS date) <= @asOf)
    ORDER BY InvDate, Id
    `,
    (req) => {
      req.input("clientId", sql.Int, clientId);
      req.input("asOf", sql.Date, asOf || null);
    },
  );
  return rows.map(mapShare);
}

export async function loadCash(clientId: number, asOf?: string): Promise<ExtCashRow[]> {
  const bind = (req: sql.Request) => {
    req.input("clientId", sql.Int, clientId);
    req.input("asOf", sql.Date, asOf || null);
  };
  const baseWhere = `
    FROM CashTransactions
    WHERE ObjCode = @clientId
      AND (@asOf IS NULL OR CAST(PostDate AS date) <= @asOf)
    ORDER BY PostDate, Id
  `;
  // Prefer InvoiceNo/InvoiceType when staging columns exist (client 2026-09 voice note).
  try {
    const rows = await queryRows(
      `
      SELECT Id, DocCode, DocNo, SerNo, Nin, MainObjCode, ObjCode,
             DbAmt, CrAmt, Remarks, ERemarks, DocDate, PostDate, DocAmt, Status,
             InvoiceNo, InvoiceType
      ${baseWhere}
      `,
      bind,
    );
    return rows.map(mapCash);
  } catch {
    const rows = await queryRows(
      `
      SELECT Id, DocCode, DocNo, SerNo, Nin, MainObjCode, ObjCode,
             DbAmt, CrAmt, Remarks, ERemarks, DocDate, PostDate, DocAmt, Status
      ${baseWhere}
      `,
      bind,
    );
    return rows.map(mapCash);
  }
}

export async function getSyncStatus() {
  const rows = await queryRows(`
    SELECT EntityName, LastSyncedTime, LastRunStatus, LastRunAt, UpdatedAt
    FROM SyncWatermark
    ORDER BY EntityName
  `);
  return rows.map((row) => ({
    entityName: String(pick(row, "EntityName", "entityName") ?? ""),
    lastSyncedTime: pick(row, "LastSyncedTime", "lastSyncedTime") ?? null,
    lastRunStatus: String(pick(row, "LastRunStatus", "lastRunStatus") ?? ""),
    lastRunAt: pick(row, "LastRunAt", "lastRunAt") ?? null,
    updatedAt: pick(row, "UpdatedAt", "updatedAt") ?? null,
  }));
}

function toNullableMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type QscPortfolioSnapshotRow = {
  clientId: number;
  snapshotDate: string;
  portfolioValue: number | null;
  systemCash: number | null;
  bankBalance: number | null;
  updatedAt: Date | null;
  name: string;
  nameEn: string;
  nameAr: string;
};

/** Read-only. QSC owns writes to ClientPortfolioSnapshot (~15:00 Asia/Qatar). */
export async function loadClientPortfolioSnapshots(asOf: string): Promise<QscPortfolioSnapshotRow[]> {
  const rows = await queryRows(
    `
    SELECT s.ClientId, s.SnapshotDate, s.PortfolioValue, s.SystemCash, s.BankBalance, s.UpdatedAt,
           i.NAME_EN, i.CLE_CLIENT_NAME, i.I_DESC
    FROM ClientPortfolioSnapshot s
    LEFT JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(s.ClientId AS nvarchar(32))
    WHERE CAST(s.SnapshotDate AS date) = @asOf
    ORDER BY s.ClientId
    `,
    (req) => req.input("asOf", sql.Date, asOf),
  );
  return rows.map((row) => {
    const clientId = toNum(pick(row, "ClientId", "clientId"));
    const names = namesFromInvestor(row);
    return {
      clientId,
      snapshotDate: toYmd(pick(row, "SnapshotDate", "snapshotDate")) || asOf,
      portfolioValue: toNullableMoney(pick(row, "PortfolioValue", "portfolioValue")),
      systemCash: toNullableMoney(pick(row, "SystemCash", "systemCash")),
      bankBalance: toNullableMoney(pick(row, "BankBalance", "bankBalance")),
      updatedAt: toDateOrNull(pick(row, "UpdatedAt", "updatedAt")),
      name: investorDisplayName(names, String(clientId)),
      nameEn: names.nameEn,
      nameAr: names.nameAr,
    };
  });
}

export async function latestQscSnapshotDate(): Promise<string | null> {
  const rows = await queryRows(`
    SELECT MAX(CAST(SnapshotDate AS date)) AS LatestDate
    FROM ClientPortfolioSnapshot
  `);
  const raw = pick(rows[0] ?? {}, "LatestDate", "latestDate");
  const ymd = toYmd(raw);
  return ymd || null;
}

export async function listQscSnapshotDates(): Promise<Array<{ date: string; rows: number; lastUpdated: string | null }>> {
  const rows = await queryRows(`
    SELECT CAST(SnapshotDate AS date) AS d, COUNT(*) AS n, MAX(UpdatedAt) AS lastAt
    FROM ClientPortfolioSnapshot
    GROUP BY CAST(SnapshotDate AS date)
    ORDER BY d DESC
  `);
  return rows.map((row) => {
    const at = toDateOrNull(pick(row, "lastAt", "LastAt"));
    return {
      date: toYmd(pick(row, "d", "D")) || String(pick(row, "d", "D") ?? "").slice(0, 10),
      rows: Number(pick(row, "n", "N") ?? 0),
      lastUpdated: at ? at.toISOString() : null,
    };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
}

async function stockMasterByTicker(tickers: string[]) {
  const unique = [...new Set(tickers.filter(Boolean))];
  if (unique.length === 0) {
    return { sectors: new Map<string, string>(), stockIds: new Map<string, string>(), prices: new Map<string, number>() };
  }
  const stocks = await db.select({
    id: schema.stocks.id,
    ticker: schema.stocks.ticker,
    sector: schema.stocks.sector,
  }).from(schema.stocks).where(inArray(schema.stocks.ticker, unique));

  const sectors = new Map<string, string>();
  const stockIds = new Map<string, string>();
  for (const s of stocks) {
    sectors.set(s.ticker, s.sector || "Unclassified");
    stockIds.set(s.ticker, s.id);
  }
  return { sectors, stockIds, prices: new Map<string, number>() };
}

export async function loadOfficialCloses(tickers: string[], asOf: string): Promise<Map<string, { price: number; date: string }>> {
  const unique = [...new Set(tickers.map((t) => t.trim()).filter(Boolean))];
  const out = new Map<string, { price: number; date: string }>();
  if (unique.length === 0) return out;
  const master = await stockMasterByTicker(unique);
  const ids = [...master.stockIds.values()];
  if (ids.length === 0) return out;
  const rows = await db.select({
    stockId: schema.stockPrices.stockId,
    date: schema.stockPrices.date,
    price: schema.stockPrices.price,
  }).from(schema.stockPrices)
    .where(and(inArray(schema.stockPrices.stockId, ids), eq(schema.stockPrices.date, asOf)));

  const byStock = new Map<string, { price: number; date: string }>();
  for (const row of rows) {
    const price = toNum(row.price);
    if (price > 0) byStock.set(row.stockId, { price, date: toYmd(row.date) });
  }
  for (const [ticker, id] of master.stockIds) {
    const close = byStock.get(id);
    if (close) out.set(ticker, close);
  }
  return out;
}

async function lastCloses(stockIds: Map<string, string>, asOf: string): Promise<Map<string, number>> {
  const ids = [...stockIds.values()];
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    stockId: schema.stockPrices.stockId,
    date: schema.stockPrices.date,
    price: schema.stockPrices.price,
  }).from(schema.stockPrices)
    .where(and(inArray(schema.stockPrices.stockId, ids), lte(schema.stockPrices.date, asOf)))
    .orderBy(asc(schema.stockPrices.date));

  const byStock = new Map<string, number>();
  for (const row of rows) {
    byStock.set(row.stockId, toNum(row.price));
  }
  const byTicker = new Map<string, number>();
  for (const [ticker, id] of stockIds) {
    const px = byStock.get(id);
    if (px != null) byTicker.set(ticker, px);
  }
  return byTicker;
}

async function dsmIndexPerformance(fromDate: string, asOf: string) {
  const all = await db.select().from(schema.indices);
  const names = ["DSM", "QE Index", "QE General"];
  const found = all.find((i) => names.some((n) => i.name.toUpperCase().includes(n.toUpperCase())));
  if (!found) return null;

  const points = await db.select({
    date: schema.indexDataPoints.date,
    value: schema.indexDataPoints.value,
  }).from(schema.indexDataPoints)
    .where(and(eq(schema.indexDataPoints.indexId, found.id), lte(schema.indexDataPoints.date, asOf)))
    .orderBy(asc(schema.indexDataPoints.date));
  if (points.length === 0) return null;

  const startPt = [...points].reverse().find((p) => p.date <= fromDate) ?? points[0];
  const endPt = points[points.length - 1];
  const ratio = indexLevelReturn(toNum(startPt.value), toNum(endPt.value));
  return {
    indexName: found.name,
    fromDate,
    toDate: asOf,
    indexPerformancePct: ratio == null ? null : Math.round(ratio * 1_000_000) / 10_000,
  };
}

function fallbackName(clientId: number, nin: string) {
  return nin ? `NIN ${nin}` : `Account ${clientId}`;
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

function namesFromInvestor(row: Record<string, unknown> | null | undefined) {
  const nameEn = textOrEmpty(pick(row ?? {}, "NAME_EN", "nameEn", "NameEn"));
  const nameAr = textOrEmpty(pick(row ?? {}, "CLE_CLIENT_NAME", "cleClientName", "CleClientName"));
  const iDesc = textOrEmpty(pick(row ?? {}, "I_DESC", "iDesc"));
  return { nameEn, nameAr, iDesc };
}

function investorRecordFromRow(row: Record<string, unknown> | null | undefined) {
  const names = namesFromInvestor(row);
  return {
    ...names,
    nin: textOrEmpty(pick(row ?? {}, "NIN", "nin")),
    cAccount: emptyToNull(textOrEmpty(pick(row ?? {}, "C_ACCOUNT", "cAccount"))),
    clientType: emptyToNull(textOrEmpty(pick(row ?? {}, "CL_CLIENT_TYPE", "clClientType"))),
    email: emptyToNull(textOrEmpty(pick(row ?? {}, "EMAIL_ADDRESS", "emailAddress"))),
    mobile: emptyToNull(textOrEmpty(pick(row ?? {}, "MOBILE_NO", "mobileNo"))),
    mainClientId: emptyToNull(textOrEmpty(pick(row ?? {}, "CL_MAIN_CLIENT_ID", "clMainClientId"))),
  };
}

async function loadInvestor(clientId: number, nin: string) {
  const rows = await queryRows(
    `
    SELECT TOP 1 NAME_EN, CLE_CLIENT_NAME, I_DESC, NIN, CL_CLIENT_ID, CL_MAIN_CLIENT_ID,
           C_ACCOUNT, CL_CLIENT_TYPE, EMAIL_ADDRESS, MOBILE_NO
    FROM Investors
    WHERE LTRIM(RTRIM(CAST(CL_CLIENT_ID AS nvarchar(32)))) = CAST(@clientId AS nvarchar(32))
       OR (@nin <> N'' AND LTRIM(RTRIM(NIN)) = @nin)
    ORDER BY CASE
      WHEN LTRIM(RTRIM(CAST(CL_CLIENT_ID AS nvarchar(32)))) = CAST(@clientId AS nvarchar(32)) THEN 0
      ELSE 1
    END
    `,
    (req) => {
      req.input("clientId", sql.Int, clientId);
      req.input("nin", sql.NVarChar(32), nin);
    },
  );
  return rows[0] ?? null;
}

function investorDetailsFromRow(row: Record<string, unknown> | null | undefined) {
  const addressEn = textOrEmpty(pick(row ?? {}, "CLE_ADDRESS", "cleAddress"));
  const addressAr = textOrEmpty(pick(row ?? {}, "CLA_ADDRESS", "claAddress"));
  const cityEn = textOrEmpty(pick(row ?? {}, "E_CITY_NAME", "eCityName"));
  const cityAr = textOrEmpty(pick(row ?? {}, "CITY_NAME", "cityName"));
  return {
    poBox: emptyToNull(textOrEmpty(pick(row ?? {}, "CL_PO_BOX", "clPoBox"))),
    fax: emptyToNull(textOrEmpty(pick(row ?? {}, "FAX_NUMBER", "faxNumber"))),
    address: emptyToNull(addressEn || addressAr),
    city: emptyToNull(cityEn || cityAr),
  };
}

async function loadInvestorDetails(clientId: number) {
  const rows = await queryRows(
    `
    SELECT TOP 1 CLA_ADDRESS, CLE_ADDRESS, FAX_NUMBER, CL_PO_BOX, CITY_NAME, E_CITY_NAME
    FROM InvestorsDetails
    WHERE LTRIM(RTRIM(CAST(CL_CLIENT_ID AS nvarchar(32)))) = CAST(@clientId AS nvarchar(32))
    `,
    (req) => req.input("clientId", sql.Int, clientId),
  );
  return rows[0] ?? null;
}

async function loadInvestorProfile(clientId: number, nin: string) {
  const [investorRow, detailsRow] = await Promise.all([
    loadInvestor(clientId, nin),
    loadInvestorDetails(clientId),
  ]);
  return {
    ...investorRecordFromRow(investorRow),
    ...investorDetailsFromRow(detailsRow),
  };
}

async function loadSecurityMaster(tickers: string[]) {
  const unique = [...new Set(tickers.map((t) => t.trim()).filter(Boolean))];
  const companyNames = new Map<string, string>();
  const sqlSectors = new Map<string, string>();
  const compIds = new Map<string, number>();
  if (unique.length === 0) return { companyNames, sqlSectors, compIds };

  const rows = await queryRows(
    `
    SELECT
      LTRIM(RTRIM(c.TICKER_ID)) AS TickerId,
      c.SC_COMP_ID,
      c.SCE_LONG_NAME, c.SCA_LONG_NAME, c.SCE_SHORT_NAME, c.SCA_SHORT_NAME,
      s.E_S_DESC, s.S_DESC
    FROM CB_SEC_COMP c
    LEFT JOIN SECTORS s ON CAST(s.S_CODE AS int) = CAST(c.SC_SEC_CODE AS int)
    WHERE LTRIM(RTRIM(c.TICKER_ID)) IN (${unique.map((_, i) => `@t${i}`).join(", ")})
    `,
    (req) => {
      unique.forEach((ticker, i) => req.input(`t${i}`, sql.NVarChar(32), ticker));
    },
  );

  for (const row of rows) {
    const ticker = textOrEmpty(pick(row, "TickerId", "tickerId"));
    if (!ticker) continue;
    const company =
      textOrEmpty(pick(row, "SCE_LONG_NAME", "sceLongName"))
      || textOrEmpty(pick(row, "SCA_LONG_NAME", "scaLongName"))
      || textOrEmpty(pick(row, "SCE_SHORT_NAME", "sceShortName"))
      || textOrEmpty(pick(row, "SCA_SHORT_NAME", "scaShortName"));
    if (company) companyNames.set(ticker, company);
    const sector =
      textOrEmpty(pick(row, "E_S_DESC", "eSDesc"))
      || textOrEmpty(pick(row, "S_DESC", "sDesc"));
    if (sector) sqlSectors.set(ticker, sector);
    const compIdRaw = pick(row, "SC_COMP_ID", "scCompId");
    if (compIdRaw != null && compIdRaw !== "") {
      const id = toNum(compIdRaw);
      if (id) compIds.set(ticker, id);
    }
  }
  return { companyNames, sqlSectors, compIds };
}

export async function reconstructClient(clientId: number, asOf: string, shares: ExtShareRow[], cash: ExtCashRow[]) {
  const events = eventsFromShares(shares, asOf);
  const cashAsOf = cashRowsThrough(cash, asOf);
  const cashBal = cashBalance(cashAsOf, asOf);
  const tickers = [...new Set(shares.map((s) => s.tickerId.trim()).filter(Boolean))];
  const [master, sqlMaster] = await Promise.all([
    stockMasterByTicker(tickers),
    loadSecurityMaster(tickers),
  ]);
  for (const [ticker, sector] of sqlMaster.sqlSectors) {
    master.sectors.set(ticker, sector);
  }
  const prices = await lastCloses(master.stockIds, asOf);
  const holdings = buildExtHoldings({
    events,
    shares,
    asOf,
    cash: cashBal,
    prices,
    sectors: master.sectors,
    stockIds: master.stockIds,
    companyNames: sqlMaster.companyNames,
    compIds: sqlMaster.compIds,
  });
  const workbook = buildExtWorkbook(holdings, cashBal);
  const equityMv = holdings.reduce((s, h) => s + h.currentValue, 0);
  const openCost = holdings.reduce((s, h) => s + h.totalCost, 0);
  const start = firstActivityDate(shares, cashAsOf);
  const indexPerf = start ? await dsmIndexPerformance(start, asOf) : null;
  const unrealized = holdings.reduce((s, h) => s + h.gainLossValue, 0);
  const allocation = navAllocation(holdings, cashBal);
  const mainObjCode = cashAsOf.find((r) => r.mainObjCode)?.mainObjCode
    ?? cash.find((r) => r.mainObjCode)?.mainObjCode
    ?? null;
  const nin = shares[0]?.nin || cash[0]?.nin || "";
  const profile = await loadInvestorProfile(clientId, nin);
  const names = { nameEn: profile.nameEn, nameAr: profile.nameAr, iDesc: "" };
  const fallback = fallbackName(clientId, nin);

  return {
    clientId,
    nin: profile.nin || nin,
    mainObjCode,
    accountNumber: String(clientId),
    name: investorDisplayName(names, fallback),
    nameEn: names.nameEn,
    nameAr: names.nameAr,
    cAccount: profile.cAccount,
    clientType: profile.clientType,
    email: profile.email,
    mobile: profile.mobile,
    poBox: profile.poBox,
    fax: profile.fax,
    address: profile.address,
    city: profile.city,
    asOf,
    cashBalance: cashBal,
    equityMv: Math.round(equityMv * 10000) / 10000,
    navValue: Math.round((equityMv + cashBal) * 10000) / 10000,
    totalInvested: Math.round(openCost * 10000) / 10000,
    currentValue: Math.round(equityMv * 10000) / 10000,
    returnPct: workbook.growthPct,
    unrealizedPnL: Math.round(unrealized * 10000) / 10000,
    realizedPnL: realizedFromEvents(events),
    holdings,
    allocation,
    excelWorkbook: {
      ...workbook,
      indexPerformancePct: indexPerf?.indexPerformancePct ?? null,
      indexName: indexPerf?.indexName ?? null,
      indexFromDate: indexPerf?.fromDate ?? null,
      indexToDate: indexPerf?.toDate ?? asOf,
    },
    dailyChanges: [] as Array<{ date: string; nav: number; chgQar: number | null; chgPct: number | null }>,
  };
}

/** List identity + cash totals only. Full NAV replay stays on the detail route. */
export async function listExtClients(asOf: string) {
  const rows = await queryRows(
    `
    SELECT
      COALESCE(s.ClientId, c.ObjCode) AS ClientId,
      COALESCE(s.Nin, c.Nin) AS Nin,
      c.MainObjCode,
      ISNULL(s.shareCount, 0) AS shareCount,
      ISNULL(c.cashCount, 0) AS cashCount,
      s.firstShare,
      s.lastShare,
      ISNULL(c.cashBal, 0) AS cashBal,
      i.NAME_EN, i.CLE_CLIENT_NAME, i.I_DESC,
      i.EMAIL_ADDRESS, i.MOBILE_NO
    FROM (
      SELECT ClientId, MAX(Nin) AS Nin, COUNT(*) AS shareCount,
             MIN(InvDate) AS firstShare, MAX(InvDate) AS lastShare
      FROM ShareTransactions
      WHERE CAST(InvDate AS date) <= @asOf
      GROUP BY ClientId
    ) s
    FULL OUTER JOIN (
      SELECT ObjCode, MAX(Nin) AS Nin,
             MAX(CAST(MainObjCode AS varchar(32))) AS MainObjCode,
             COUNT(*) AS cashCount,
             SUM(ISNULL(CrAmt, 0) - ISNULL(DbAmt, 0)) AS cashBal
      FROM CashTransactions
      WHERE CAST(PostDate AS date) <= @asOf
      GROUP BY ObjCode
    ) c ON s.ClientId = c.ObjCode
    LEFT JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(COALESCE(s.ClientId, c.ObjCode) AS nvarchar(32))
    ORDER BY COALESCE(s.ClientId, c.ObjCode)
    `,
    (req) => req.input("asOf", sql.Date, asOf),
  );

  return rows.map((row) => {
    const clientId = toNum(pick(row, "ClientId", "clientId"));
    const nin = String(pick(row, "Nin", "nin") ?? "").trim();
    const mainObjCode = pick(row, "MainObjCode", "mainObjCode") == null
      ? null
      : String(pick(row, "MainObjCode", "mainObjCode"));
    const names = namesFromInvestor(row);
    const fallback = fallbackName(clientId, nin);
    return {
      id: String(clientId),
      clientId,
      nin,
      mainObjCode,
      accountNumber: String(clientId),
      name: investorDisplayName(names, fallback),
      nameEn: names.nameEn,
      nameAr: names.nameAr,
      shareCount: toNum(pick(row, "shareCount")),
      cashCount: toNum(pick(row, "cashCount")),
      firstShare: toYmd(pick(row, "firstShare")) || null,
      lastShare: toYmd(pick(row, "lastShare")) || null,
      cashBalance: Math.round(toNum(pick(row, "cashBal")) * 10000) / 10000,
      email: emptyToNull(textOrEmpty(pick(row, "EMAIL_ADDRESS", "emailAddress"))),
      mobile: emptyToNull(textOrEmpty(pick(row, "MOBILE_NO", "mobileNo"))),
      navValue: null as number | null,
      totalInvested: null as number | null,
      returnPct: null as number | null,
    };
  });
}

export async function getExtClient(clientId: number, asOf: string) {
  const [shares, cash] = await Promise.all([loadShares(clientId), loadCash(clientId)]);
  if (shares.length === 0 && cash.length === 0) return null;
  return reconstructClient(clientId, asOf, shares, cash);
}

export async function getPortfolioStatement(
  clientId: number,
  asOf: string,
  printedAtIso = new Date().toISOString(),
  opts?: { includeZeroQty?: boolean },
) {
  const [shares, cash] = await Promise.all([loadShares(clientId, asOf), loadCash(clientId, asOf)]);
  if (shares.length === 0 && cash.length === 0) return null;
  const tickers = [...new Set(shares.map((s) => s.tickerId.trim()).filter(Boolean))];
  const [sqlMaster, closes] = await Promise.all([
    loadSecurityMaster(tickers),
    loadOfficialCloses(tickers, asOf),
  ]);
  const nin = shares[0]?.nin || cash[0]?.nin || "";
  const investor = await statementInvestorHeader(clientId, nin, cash);
  return portfolioStatementFromLedgers({
    asOf,
    accountId: clientId,
    shares,
    cash,
    investor,
    sectors: sqlMaster.sqlSectors,
    companyNames: sqlMaster.companyNames,
    closes,
    printedAtIso,
    includeZeroQty: opts?.includeZeroQty,
  });
}

async function statementInvestorHeader(clientId: number, nin: string, cash: ExtCashRow[]) {
  const profile = await loadInvestorProfile(clientId, nin);
  const fallback = fallbackName(clientId, nin);
  const names = { nameEn: profile.nameEn, nameAr: profile.nameAr, iDesc: "" };
  return applySampleInvestorKbHeader(buildInvestorHeader({
    accountId: clientId,
    nin: profile.nin || nin,
    nameEn: profile.nameEn,
    nameAr: profile.nameAr,
    displayName: investorDisplayName(names, fallback),
    clientCode: cash.find((r) => r.mainObjCode)?.mainObjCode ?? profile.mainClientId,
    cAccount: profile.cAccount,
    clientType: profile.clientType,
    email: profile.email,
    mobile: profile.mobile,
    poBox: profile.poBox,
    fax: profile.fax,
    address: profile.address,
    city: profile.city,
  }));
}

export async function getAccountStatement(
  clientId: number,
  from: string,
  to: string,
  printedAtIso = new Date().toISOString(),
  layout: "grouped" | "detailed" = "grouped",
) {
  const [cash, shares] = await Promise.all([loadCash(clientId, to), loadShares(clientId, to)]);
  if (cash.length === 0 && shares.length === 0) return null;
  const nin = cash[0]?.nin || shares[0]?.nin || "";
  return assembleAccountStatement({
    from,
    to,
    investor: await statementInvestorHeader(clientId, nin, cash),
    cash,
    shares,
    layout,
    printedAtIso,
  });
}

export async function getRealizedDetailsStatement(
  clientId: number,
  from: string,
  to: string,
  printedAtIso = new Date().toISOString(),
  ticker?: string | null,
) {
  const [shares, cash] = await Promise.all([loadShares(clientId, to), loadCash(clientId, to)]);
  if (shares.length === 0 && cash.length === 0) return null;
  const nin = shares[0]?.nin || cash[0]?.nin || "";
  const tickers = [...new Set(shares.map((s) => s.tickerId.trim()).filter(Boolean))];
  const master = await loadSecurityMaster(tickers);
  return assembleRealizedDetails({
    from,
    to,
    investor: await statementInvestorHeader(clientId, nin, cash),
    shares,
    printedAtIso,
    ticker: ticker?.trim() || null,
    sectors: master.sqlSectors,
  });
}

export async function getRealizedSummaryStatement(
  clientId: number,
  from: string,
  to: string,
  printedAtIso = new Date().toISOString(),
) {
  const shares = await loadShares(clientId, to);
  const cash = await loadCash(clientId, to);
  if (shares.length === 0 && cash.length === 0) return null;
  const nin = shares[0]?.nin || cash[0]?.nin || "";
  return assembleRealizedSummary({
    dates: { mode: "range", from, to },
    investor: await statementInvestorHeader(clientId, nin, cash),
    shares,
    printedAtIso,
  });
}

export type ExtShareLedgerFilter = {
  qLike?: string | null;
  side?: string | null;
  invType?: string | null;
};

export type ExtCashLedgerFilter = {
  qLike?: string | null;
  status?: string | null;
  from?: string | null;
};

function bindShareFilters(
  req: sql.Request,
  clientId: number,
  asOf: string,
  filter: ExtShareLedgerFilter,
  offset?: number,
  pageSize?: number,
) {
  req.input("clientId", sql.Int, clientId);
  req.input("asOf", sql.Date, asOf);
  req.input("qLike", sql.NVarChar(80), filter.qLike ?? null);
  req.input("side", sql.NVarChar(8), filter.side ?? null);
  req.input("invType", sql.NVarChar(8), filter.invType ?? null);
  if (offset != null) req.input("offset", sql.Int, offset);
  if (pageSize != null) req.input("pageSize", sql.Int, pageSize);
}

const SHARE_FILTER_SQL = `
  AND (@qLike IS NULL OR (
    TickerId LIKE @qLike
    OR ISNULL(SceLongName, '') LIKE @qLike
    OR ISNULL(ScaLongName, '') LIKE @qLike
    OR ISNULL(SceShortName, '') LIKE @qLike
    OR ISNULL(ScaShortName, '') LIKE @qLike
  ))
  AND (@invType IS NULL OR InvType = @invType)
  AND (
    @side IS NULL
    OR (@side = 'SP' AND UPPER(InvType) = 'SP')
    OR (@side = 'BUY' AND UPPER(BuySellFlag) = 'B' AND UPPER(InvType) <> 'SP')
    OR (@side = 'SELL' AND UPPER(BuySellFlag) = 'S' AND UPPER(InvType) <> 'SP')
  )
`;

const CASH_FILTER_SQL = `
  AND (@qLike IS NULL OR (
    ISNULL(Remarks, '') LIKE @qLike
    OR ISNULL(ERemarks, '') LIKE @qLike
    OR ISNULL(DocCode, '') LIKE @qLike
    OR CAST(ISNULL(DocNo, 0) AS varchar(32)) LIKE @qLike
  ))
  AND (@status IS NULL OR Status = @status)
`;

export async function getExtSharesLedger(
  clientId: number,
  asOf: string,
  page: number,
  pageSize: number,
  filter: ExtShareLedgerFilter = {},
) {
  const countRows = await queryRows(
    `
    SELECT COUNT(*) AS total
    FROM ShareTransactions
    WHERE ClientId = @clientId
      AND CAST(InvDate AS date) <= @asOf
      ${SHARE_FILTER_SQL}
    `,
    (req) => bindShareFilters(req, clientId, asOf, filter),
  );
  const total = toNum(pick(countRows[0] ?? {}, "total", "Total"));
  const meta = paginateMeta(total, page, pageSize);
  const rows = await queryRows(
    `
    SELECT Id, CompId, TickerId, ScaLongName, SceLongName, ScaShortName, SceShortName,
           InvNo, InvType, InvDate, BuySellFlag, Nin, ClientId,
           Qty, AvgPrice, Total, Net, TotalComm, OfficeComm, MarketComm, OriginalPrice
    FROM ShareTransactions
    WHERE ClientId = @clientId
      AND CAST(InvDate AS date) <= @asOf
      ${SHARE_FILTER_SQL}
    ORDER BY InvDate, Id
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `,
    (req) => bindShareFilters(req, clientId, asOf, filter, meta.offset, meta.pageSize),
  );
  const items = rows.map((raw) => {
    const row = mapShare(raw);
    return {
      id: String(row.id),
      date: row.invDate,
      ticker: row.tickerId,
      companyName: row.companyName || row.tickerId,
      invType: row.invType,
      buySellFlag: row.buySellFlag,
      side: row.invType.toUpperCase() === "SP" ? "SP" : (row.buySellFlag.toUpperCase() === "S" ? "SELL" : row.buySellFlag.toUpperCase() === "B" ? "BUY" : row.buySellFlag),
      quantity: row.qty,
      avgPrice: row.avgPrice,
      total: row.total,
      net: row.net,
      totalComm: row.totalComm,
      officeComm: row.officeComm,
      marketComm: row.marketComm,
      originalPrice: row.originalPrice,
      unitPrice: unitPriceFromShare(row),
      invNo: row.invNo,
      compId: row.compId,
    };
  });
  return { items, pagination: { page: meta.page, pageSize: meta.pageSize, total: meta.total, totalPages: meta.totalPages } };
}

export async function getExtCashLedger(
  clientId: number,
  asOf: string,
  page: number,
  pageSize: number,
  filter: ExtCashLedgerFilter = {},
) {
  const summaryRows = await queryRows(
    `
    SELECT COUNT(*) AS total,
           SUM(ISNULL(CrAmt, 0) - ISNULL(DbAmt, 0)) AS cashBal
    FROM CashTransactions
    WHERE ObjCode = @clientId
      AND CAST(PostDate AS date) <= @asOf
    `,
    (req) => {
      req.input("clientId", sql.Int, clientId);
      req.input("asOf", sql.Date, asOf);
    },
  );
  const filteredCount = await queryRows(
    `
    SELECT COUNT(*) AS total
    FROM CashTransactions
    WHERE ObjCode = @clientId
      AND CAST(PostDate AS date) <= @asOf
      AND (@fromDate IS NULL OR CAST(PostDate AS date) >= @fromDate)
      ${CASH_FILTER_SQL}
    `,
    (req) => {
      req.input("clientId", sql.Int, clientId);
      req.input("asOf", sql.Date, asOf);
      req.input("fromDate", sql.Date, filter.from || null);
      req.input("qLike", sql.NVarChar(80), filter.qLike ?? null);
      req.input("status", sql.NVarChar(8), filter.status ?? null);
    },
  );
  const total = toNum(pick(filteredCount[0] ?? {}, "total", "Total"));
  const balance = Math.round(toNum(pick(summaryRows[0] ?? {}, "cashBal", "CashBal")) * 10000) / 10000;
  const meta = paginateMeta(total, page, pageSize);
  const rows = await queryRows(
    `
    WITH ledger AS (
      SELECT Id, DocCode, DocNo, SerNo, Nin, MainObjCode, ObjCode,
             DbAmt, CrAmt, Remarks, ERemarks, DocDate, PostDate, DocAmt, Status,
             SUM(ISNULL(CrAmt, 0) - ISNULL(DbAmt, 0)) OVER (ORDER BY PostDate, Id ROWS UNBOUNDED PRECEDING) AS BalanceAfter
      FROM CashTransactions
      WHERE ObjCode = @clientId
        AND CAST(PostDate AS date) <= @asOf
    )
    SELECT *
    FROM ledger
    WHERE 1 = 1
      AND (@fromDate IS NULL OR CAST(PostDate AS date) >= @fromDate)
      ${CASH_FILTER_SQL}
    ORDER BY PostDate, Id
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `,
    (req) => {
      req.input("clientId", sql.Int, clientId);
      req.input("asOf", sql.Date, asOf);
      req.input("fromDate", sql.Date, filter.from || null);
      req.input("qLike", sql.NVarChar(80), filter.qLike ?? null);
      req.input("status", sql.NVarChar(8), filter.status ?? null);
      req.input("offset", sql.Int, meta.offset);
      req.input("pageSize", sql.Int, meta.pageSize);
    },
  );
  const items = rows.map((raw) => {
    const row = mapCash(raw);
    return {
      ...row,
      balanceAfter: Math.round(toNum(pick(raw, "BalanceAfter", "balanceAfter")) * 10000) / 10000,
    };
  });
  return {
    balance,
    items,
    pagination: { page: meta.page, pageSize: meta.pageSize, total: meta.total, totalPages: meta.totalPages },
  };
}
