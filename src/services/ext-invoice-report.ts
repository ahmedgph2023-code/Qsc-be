import { getMssqlPool, sql } from "../db/mssql.js";
import { investorDisplayName, textOrEmpty, toNum, toYmd } from "./ext-sql-portfolio.js";

const MARKET_LABEL = "QATAR STOCK EXCHANGE";
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

export type InvoiceOrderSide = "Buy" | "Sell";

export type InvoiceReportRow = {
  /** ShareTransactions.InvoiceSequence — groups executions of the same stock + side. */
  invSequence: number | null;
  /** ShareTransactions.InvNo — the individual invoice / execution number. */
  invNo: number | null;
  orderSide: InvoiceOrderSide;
  invType: "OI" | "OC";
  /** Kept for row identity and drill-down; not shown as a report column (FB-2026-09-19). */
  accountId: number;
  nin: string;
  accountName: string;
  ticker: string;
  company: string;
  market: string;
  tradeDate: string;
  qty: number;
  priceAvg: number;
  amount: number;
  totalComm: number;
  officeComm: number;
  marketComm: number;
  net: number;
};

/** Report scope: both sides, buys only (OI) or sells only (OC). */
export type InvoiceOrderTypeFilter = "all" | "buy" | "sell";

export type InvoiceReportFilters = {
  clientId: number | null;
  /** Resolved from the matching rows so exports can print a name, not just an id. */
  clientName: string | null;
  ticker: string | null;
  orderType: InvoiceOrderTypeFilter;
  invNo: number | null;
};

export type InvoiceReportResult = {
  title: "Customer Invoices";
  from: string;
  to: string;
  filters: InvoiceReportFilters;
  rows: InvoiceReportRow[];
  totals: {
    amount: number;
    totalComm: number;
    officeComm: number;
    marketComm: number;
    net: number;
    qty: number;
    count: number;
  };
};

export function invoiceSideFromInvType(invType: string): InvoiceOrderSide | null {
  const t = invType.trim().toUpperCase();
  if (t === "OI") return "Buy";
  if (t === "OC") return "Sell";
  return null;
}

function namesFromInvestor(row: Record<string, unknown>) {
  return {
    nameEn: textOrEmpty(pick(row, "NAME_EN", "nameEn")),
    nameAr: textOrEmpty(pick(row, "CLE_CLIENT_NAME", "cleClientName")),
    iDesc: textOrEmpty(pick(row, "I_DESC", "iDesc")),
  };
}

export function mapInvoiceReportRow(row: Record<string, unknown>): InvoiceReportRow | null {
  const invTypeRaw = String(pick(row, "InvType", "invType") ?? "").trim().toUpperCase();
  const side = invoiceSideFromInvType(invTypeRaw);
  if (!side) return null;
  const qty = toNum(pick(row, "Qty", "qty"));
  const accountId = toNum(pick(row, "ClientId", "clientId", "AccountId", "accountId"));
  const nin = textOrEmpty(pick(row, "Nin", "nin"));
  const names = namesFromInvestor(row);
  const ticker = textOrEmpty(pick(row, "TickerId", "tickerId"));
  const long = textOrEmpty(pick(row, "SceLongName", "sceLongName", "ScaLongName", "scaLongName"));
  const short = textOrEmpty(pick(row, "SceShortName", "sceShortName", "ScaShortName", "scaShortName"));
  return {
    invSequence: numberOrNull(pick(row, "InvoiceSequence", "invoiceSequence", "invSequence")),
    invNo: numberOrNull(pick(row, "InvNo", "invNo")),
    orderSide: side,
    invType: invTypeRaw as "OI" | "OC",
    accountId,
    nin,
    accountName: investorDisplayName(names, String(accountId || nin || "")),
    ticker,
    company: long || short || ticker,
    market: MARKET_LABEL,
    tradeDate: toYmd(pick(row, "InvDate", "invDate")),
    qty,
    priceAvg: toNum(pick(row, "AvgPrice", "avgPrice")),
    amount: round4(toNum(pick(row, "Total", "total"))),
    totalComm: round4(toNum(pick(row, "TotalComm", "totalComm"))),
    officeComm: round4(toNum(pick(row, "OfficeComm", "officeComm"))),
    marketComm: round4(toNum(pick(row, "MarketComm", "marketComm"))),
    net: round4(toNum(pick(row, "Net", "net"))),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  return toNum(value);
}

export function sumInvoiceTotals(rows: InvoiceReportRow[]): InvoiceReportResult["totals"] {
  return {
    amount: round4(rows.reduce((s, r) => s + r.amount, 0)),
    totalComm: round4(rows.reduce((s, r) => s + r.totalComm, 0)),
    officeComm: round4(rows.reduce((s, r) => s + r.officeComm, 0)),
    marketComm: round4(rows.reduce((s, r) => s + r.marketComm, 0)),
    net: round4(rows.reduce((s, r) => s + r.net, 0)),
    qty: round4(rows.reduce((s, r) => s + r.qty, 0)),
    count: rows.length,
  };
}

/** Report dates print as DD/MM/YYYY in both exports. */
export function formatDmY(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/**
 * Filter summary printed at the top of the Excel and PDF exports so a saved
 * report always says what it was filtered by (client brief, 19 Sep 2026).
 */
export function invoiceFilterHeaderLines(report: InvoiceReportResult): Array<{ label: string; value: string }> {
  const f = report.filters;
  return [
    { label: "Period", value: `${formatDmY(report.from)} – ${formatDmY(report.to)}` },
    {
      label: "Customer",
      value: f.clientId ? `${f.clientName ?? "—"} (${f.clientId})` : "All Customers",
    },
    { label: "Stock", value: f.ticker || "All Stocks" },
    {
      label: "Order Type",
      value: f.orderType === "buy" ? "Buy" : f.orderType === "sell" ? "Sell" : "All",
    },
    { label: "Invoice", value: f.invNo != null ? String(f.invNo) : "All Invoices" },
  ];
}

/** One entry of the Customer filter: only clients invoiced inside the chosen range. */
export type InvoiceClientOption = {
  clientId: number;
  nin: string;
  name: string;
  invoiceCount: number;
};

export function mapInvoiceClientOption(row: Record<string, unknown>): InvoiceClientOption | null {
  const clientId = toNum(pick(row, "ClientId", "clientId"));
  if (!clientId) return null;
  const nin = textOrEmpty(pick(row, "Nin", "nin"));
  return {
    clientId,
    nin,
    name: investorDisplayName(namesFromInvestor(row), String(clientId || nin)),
    invoiceCount: toNum(pick(row, "InvoiceCount", "invoiceCount")),
  };
}

/**
 * Customer dropdown scoped to the report period — the client asked for the same
 * behaviour the Stock list already has: show only who was actually invoiced.
 */
export async function listInvoiceClients(input: {
  from: string;
  to: string;
  ticker?: string | null;
  orderType?: InvoiceOrderTypeFilter;
}): Promise<InvoiceClientOption[]> {
  const pool = await getMssqlPool();
  const req = pool.request();
  req.input("from", sql.Date, input.from);
  req.input("to", sql.Date, input.to);
  req.input("ticker", sql.NVarChar(32), input.ticker?.trim() || null);
  req.input("invType", sql.NVarChar(2), invTypeFromOrderType(input.orderType ?? "all"));

  const result = await req.query(`
    SELECT
      st.ClientId,
      MAX(st.Nin) AS Nin,
      COUNT(*) AS InvoiceCount,
      MAX(i.NAME_EN) AS NAME_EN,
      MAX(i.CLE_CLIENT_NAME) AS CLE_CLIENT_NAME,
      MAX(i.I_DESC) AS I_DESC
    FROM ShareTransactions st
    LEFT JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(st.ClientId AS nvarchar(32))
    WHERE CAST(st.InvDate AS date) >= @from
      AND CAST(st.InvDate AS date) <= @to
      AND UPPER(LTRIM(RTRIM(st.InvType))) IN ('OI', 'OC')
      AND (@invType IS NULL OR UPPER(LTRIM(RTRIM(st.InvType))) = @invType)
      AND (@ticker IS NULL OR UPPER(LTRIM(RTRIM(st.TickerId))) = UPPER(@ticker))
    GROUP BY st.ClientId
    ORDER BY st.ClientId
  `);

  return (result.recordset as Record<string, unknown>[])
    .map(mapInvoiceClientOption)
    .filter((r): r is InvoiceClientOption => r != null);
}

/** `buy` → OI only, `sell` → OC only, `all` → both. */
export function invTypeFromOrderType(orderType: InvoiceOrderTypeFilter): "OI" | "OC" | null {
  if (orderType === "buy") return "OI";
  if (orderType === "sell") return "OC";
  return null;
}

export function normalizeOrderType(raw: unknown): InvoiceOrderTypeFilter {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "buy" || value === "sell" ? value : "all";
}

export async function getInvoiceReport(input: {
  from: string;
  to: string;
  clientId?: number | null;
  ticker?: string | null;
  orderType?: InvoiceOrderTypeFilter;
  invNo?: number | null;
}): Promise<InvoiceReportResult> {
  const pool = await getMssqlPool();
  const req = pool.request();
  req.input("from", sql.Date, input.from);
  req.input("to", sql.Date, input.to);
  req.input("clientId", sql.Int, input.clientId ?? null);
  const ticker = input.ticker?.trim() || null;
  req.input("ticker", sql.NVarChar(32), ticker);
  const orderType = input.orderType ?? "all";
  req.input("invType", sql.NVarChar(2), invTypeFromOrderType(orderType));
  const invNo = input.invNo ?? null;
  req.input("invNo", sql.BigInt, invNo);

  const result = await req.query(`
    SELECT
      st.InvNo, st.InvoiceSequence, st.InvType, st.ClientId, st.Nin, st.TickerId, st.InvDate,
      st.Qty, st.AvgPrice, st.Total, st.Net, st.TotalComm, st.OfficeComm, st.MarketComm,
      st.ScaLongName, st.SceLongName, st.ScaShortName, st.SceShortName,
      i.NAME_EN, i.CLE_CLIENT_NAME, i.I_DESC
    FROM ShareTransactions st
    LEFT JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(st.ClientId AS nvarchar(32))
    WHERE CAST(st.InvDate AS date) >= @from
      AND CAST(st.InvDate AS date) <= @to
      AND UPPER(LTRIM(RTRIM(st.InvType))) IN ('OI', 'OC')
      AND (@invType IS NULL OR UPPER(LTRIM(RTRIM(st.InvType))) = @invType)
      AND (@clientId IS NULL OR st.ClientId = @clientId)
      AND (@ticker IS NULL OR UPPER(LTRIM(RTRIM(st.TickerId))) = UPPER(@ticker))
      AND (@invNo IS NULL OR st.InvNo = @invNo)
    ORDER BY st.InvDate, st.InvoiceSequence, st.InvNo, st.Id
  `);

  const rows = (result.recordset as Record<string, unknown>[])
    .map(mapInvoiceReportRow)
    .filter((r): r is InvoiceReportRow => r != null);

  return {
    title: "Customer Invoices",
    from: input.from,
    to: input.to,
    filters: {
      clientId: input.clientId ?? null,
      clientName: input.clientId ? rows.find((r) => r.accountId === input.clientId)?.accountName ?? null : null,
      ticker,
      orderType,
      invNo,
    },
    rows,
    totals: sumInvoiceTotals(rows),
  };
}
