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
  invSequence: number | null;
  orderSide: InvoiceOrderSide;
  invType: "OI" | "OC";
  accountId: number;
  nin: string;
  accountName: string;
  accountType: string | null;
  ticker: string;
  company: string;
  market: string;
  tradeDate: string;
  qty: number;
  buyQty: number;
  sellQty: number;
  priceAvg: number;
  amount: number;
  totalComm: number;
  officeComm: number;
  marketComm: number;
  net: number;
};

export type InvoiceReportResult = {
  title: "Customer Invoices";
  from: string;
  to: string;
  filters: { clientId: number | null; ticker: string | null };
  rows: InvoiceReportRow[];
  totals: {
    amount: number;
    totalComm: number;
    officeComm: number;
    marketComm: number;
    net: number;
    qty: number;
    buyQty: number;
    sellQty: number;
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
  const accountType = emptyToNull(textOrEmpty(pick(row, "CL_CLIENT_TYPE", "clClientType", "AccountType", "accountType")));
  return {
    invSequence: pick(row, "InvNo", "invNo") == null || pick(row, "InvNo", "invNo") === ""
      ? null
      : toNum(pick(row, "InvNo", "invNo")),
    orderSide: side,
    invType: invTypeRaw as "OI" | "OC",
    accountId,
    nin,
    accountName: investorDisplayName(names, String(accountId || nin || "")),
    accountType,
    ticker,
    company: long || short || ticker,
    market: MARKET_LABEL,
    tradeDate: toYmd(pick(row, "InvDate", "invDate")),
    qty,
    buyQty: side === "Buy" ? qty : 0,
    sellQty: side === "Sell" ? qty : 0,
    priceAvg: toNum(pick(row, "AvgPrice", "avgPrice")),
    amount: round4(toNum(pick(row, "Total", "total"))),
    totalComm: round4(toNum(pick(row, "TotalComm", "totalComm"))),
    officeComm: round4(toNum(pick(row, "OfficeComm", "officeComm"))),
    marketComm: round4(toNum(pick(row, "MarketComm", "marketComm"))),
    net: round4(toNum(pick(row, "Net", "net"))),
  };
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

export function sumInvoiceTotals(rows: InvoiceReportRow[]): InvoiceReportResult["totals"] {
  return {
    amount: round4(rows.reduce((s, r) => s + r.amount, 0)),
    totalComm: round4(rows.reduce((s, r) => s + r.totalComm, 0)),
    officeComm: round4(rows.reduce((s, r) => s + r.officeComm, 0)),
    marketComm: round4(rows.reduce((s, r) => s + r.marketComm, 0)),
    net: round4(rows.reduce((s, r) => s + r.net, 0)),
    qty: round4(rows.reduce((s, r) => s + r.qty, 0)),
    buyQty: round4(rows.reduce((s, r) => s + r.buyQty, 0)),
    sellQty: round4(rows.reduce((s, r) => s + r.sellQty, 0)),
    count: rows.length,
  };
}

export async function getInvoiceReport(input: {
  from: string;
  to: string;
  clientId?: number | null;
  ticker?: string | null;
}): Promise<InvoiceReportResult> {
  const pool = await getMssqlPool();
  const req = pool.request();
  req.input("from", sql.Date, input.from);
  req.input("to", sql.Date, input.to);
  req.input("clientId", sql.Int, input.clientId ?? null);
  const ticker = input.ticker?.trim() || null;
  req.input("ticker", sql.NVarChar(32), ticker);

  const result = await req.query(`
    SELECT
      st.InvNo, st.InvType, st.ClientId, st.Nin, st.TickerId, st.InvDate,
      st.Qty, st.AvgPrice, st.Total, st.Net, st.TotalComm, st.OfficeComm, st.MarketComm,
      st.ScaLongName, st.SceLongName, st.ScaShortName, st.SceShortName,
      i.NAME_EN, i.CLE_CLIENT_NAME, i.I_DESC, i.CL_CLIENT_TYPE
    FROM ShareTransactions st
    LEFT JOIN Investors i
      ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
       = CAST(st.ClientId AS nvarchar(32))
    WHERE CAST(st.InvDate AS date) >= @from
      AND CAST(st.InvDate AS date) <= @to
      AND UPPER(LTRIM(RTRIM(st.InvType))) IN ('OI', 'OC')
      AND (@clientId IS NULL OR st.ClientId = @clientId)
      AND (@ticker IS NULL OR UPPER(LTRIM(RTRIM(st.TickerId))) = UPPER(@ticker))
    ORDER BY st.InvDate, st.InvNo, st.Id
  `);

  const rows = (result.recordset as Record<string, unknown>[])
    .map(mapInvoiceReportRow)
    .filter((r): r is InvoiceReportRow => r != null);

  return {
    title: "Customer Invoices",
    from: input.from,
    to: input.to,
    filters: { clientId: input.clientId ?? null, ticker },
    rows,
    totals: sumInvoiceTotals(rows),
  };
}
