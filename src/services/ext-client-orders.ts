import { getMssqlPool, sql } from "../db/mssql.js";
import { investorDisplayName, textOrEmpty, toNum, toYmd } from "./ext-sql-portfolio.js";

export const ORDER_STATUS_LABELS: Record<string, string> = {
  P: "Partially Executed",
  A: "Active",
  S: "Fully Executed",
  C: "Cancelled",
  E: "Expired",
  R: "Rejected",
};

export type OrderValidity =
  | { kind: "Daily" }
  | { kind: "Date"; until: string | null };

export type ClientCurrentOrderRow = {
  orderNumber: string;
  orderType: "Buy" | "Sell" | string;
  clientId: number | null;
  clientName: string;
  nin: string | null;
  ticker: string;
  companyName: string | null;
  statusCode: string;
  statusLabel: string;
  orderDate: string | null;
  totalQty: number | null;
  remainingQty: number | null;
  executedQty: number | null;
  displayedQty: number | null;
  orderValue: number | null;
  validity: OrderValidity;
  raw: Record<string, unknown>;
};

export type ClientCurrentOrdersResult = {
  polledAtIso: string;
  tableFound: boolean;
  columns: string[];
  rows: ClientCurrentOrderRow[];
  warning: string | null;
};

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
    const actual = lower.get(key.toLowerCase());
    if (actual && row[actual] !== undefined && row[actual] !== null) return row[actual];
  }
  return undefined;
}

function firstKey(columns: string[], candidates: string[]): string | null {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export function mapOrderType(raw: unknown): "Buy" | "Sell" | string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === "B" || s === "BUY" || s === "OI") return "Buy";
  if (s === "S" || s === "SELL" || s === "OC") return "Sell";
  return textOrEmpty(raw) || "—";
}

export function mapOrderStatus(code: unknown): { statusCode: string; statusLabel: string } {
  const statusCode = String(code ?? "").trim().toUpperCase();
  return {
    statusCode,
    statusLabel: ORDER_STATUS_LABELS[statusCode] || (statusCode || "Unknown"),
  };
}

export function mapOrderValidity(row: Record<string, unknown>, columns: string[]): OrderValidity {
  const validityKey = firstKey(columns, ["Validity", "OrderValidity", "ValidType", "ValidityType", "TIF"]);
  const dateKey = firstKey(columns, ["ValidUntil", "ValidityDate", "ExpiryDate", "ExpireDate", "GoodTillDate", "GTD"]);
  const raw = validityKey ? pick(row, validityKey) : null;
  const untilRaw = dateKey ? pick(row, dateKey) : null;
  const until = untilRaw == null || untilRaw === "" ? null : toYmd(untilRaw) || String(untilRaw);
  const token = String(raw ?? "").trim().toUpperCase();
  if (token === "D" || token === "DAY" || token === "DAILY" || token === "1") return { kind: "Daily" };
  if (token === "DATE" || token === "GTD" || token === "G" || until) return { kind: "Date", until };
  if (until) return { kind: "Date", until };
  if (!token) return { kind: "Daily" };
  return { kind: "Date", until: token };
}

export function mapClientCurrentOrder(
  row: Record<string, unknown>,
  columns: string[],
): ClientCurrentOrderRow {
  const orderNumber = String(
    pick(
      row,
      firstKey(columns, ["OrderNo", "OrdNo", "OrderNumber", "OrderId", "Id"]) || "OrderNo",
    ) ?? "",
  );
  const typeRaw = pick(
    row,
    firstKey(columns, ["BuySellFlag", "OrderSide", "BuySell", "Side", "OrderType", "BS"]) || "BuySellFlag",
  );
  const clientIdRaw = pick(
    row,
    firstKey(columns, ["ClientId", "AccountId", "ObjCode", "ClClientId"]) || "ClientId",
  );
  const clientId = clientIdRaw == null || clientIdRaw === "" ? null : toNum(clientIdRaw);
  const nin = textOrEmpty(pick(row, firstKey(columns, ["Nin", "NIN"]) || "Nin")) || null;
  const ticker = textOrEmpty(
    pick(row, firstKey(columns, ["TickerId", "Ticker", "CompTicker", "Symbol", "Security"]) || "TickerId"),
  );
  const companyName =
    textOrEmpty(
      pick(
        row,
        firstKey(columns, ["SceLongName", "CompanyName", "Company", "ScaLongName", "SecurityName"]) || "CompanyName",
      ),
    ) || null;
  const nameEn = textOrEmpty(pick(row, "NAME_EN", "nameEn", "ClientName", "AccountName"));
  const nameAr = textOrEmpty(pick(row, "CLE_CLIENT_NAME", "cleClientName"));
  const status = mapOrderStatus(
    pick(row, firstKey(columns, ["Status", "OrderStatus", "OrdStatus", "StatusCode"]) || "Status"),
  );
  const totalQty = nullableNum(pick(row, firstKey(columns, ["Qty", "TotalQty", "OrderQty", "Quantity"]) || "Qty"));
  const remainingQty = nullableNum(
    pick(row, firstKey(columns, ["RemainingQty", "RemQty", "LeavesQty", "OutstandingQty"]) || "RemainingQty"),
  );
  const executedQty = nullableNum(
    pick(row, firstKey(columns, ["ExecutedQty", "ExecQty", "FilledQty", "CumQty"]) || "ExecutedQty"),
  );
  const displayedQty = nullableNum(
    pick(row, firstKey(columns, ["DisplayedQty", "DispQty", "ShowQty", "VisibleQty"]) || "DisplayedQty"),
  );
  const orderValue = nullableNum(
    pick(row, firstKey(columns, ["OrderValue", "Value", "Amount", "Net", "Total"]) || "OrderValue"),
  );
  const orderDateRaw = pick(
    row,
    firstKey(columns, ["OrderDate", "OrdDate", "TradeDate", "CreatedAt", "EntryDate"]) || "OrderDate",
  );

  return {
    orderNumber: orderNumber || "—",
    orderType: mapOrderType(typeRaw),
    clientId,
    clientName: investorDisplayName({ nameEn, nameAr }, clientId != null ? String(clientId) : nin || "—"),
    nin,
    ticker: ticker || "—",
    companyName,
    statusCode: status.statusCode,
    statusLabel: status.statusLabel,
    orderDate: orderDateRaw == null || orderDateRaw === "" ? null : toYmd(orderDateRaw) || String(orderDateRaw),
    totalQty,
    remainingQty,
    executedQty,
    displayedQty,
    orderValue,
    validity: mapOrderValidity(row, columns),
    raw: row,
  };
}

function nullableNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function listTableColumns(tableName: string): Promise<string[]> {
  const pool = await getMssqlPool();
  const result = await pool.request().input("table", sql.NVarChar(128), tableName).query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = @table
    ORDER BY ORDINAL_POSITION
  `);
  return (result.recordset as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME);
}

export async function listClientCurrentOrders(opts?: {
  status?: string | null;
}): Promise<ClientCurrentOrdersResult> {
  const polledAtIso = new Date().toISOString();
  let columns: string[] = [];
  try {
    columns = await listTableColumns("ClientCurrentOrders");
  } catch (err: any) {
    return {
      polledAtIso,
      tableFound: false,
      columns: [],
      rows: [],
      warning: err?.message || "COLUMN_DISCOVERY_FAILED",
    };
  }
  if (columns.length === 0) {
    return {
      polledAtIso,
      tableFound: false,
      columns: [],
      rows: [],
      warning: "ClientCurrentOrders table not found on external SQL",
    };
  }

  const pool = await getMssqlPool();
  let recordset: Record<string, unknown>[] = [];
  const clientKey = firstKey(columns, ["ClientId", "AccountId", "ObjCode", "ClClientId"]);
  if (clientKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(clientKey)) {
    return {
      polledAtIso,
      tableFound: true,
      columns,
      rows: [],
      warning: "Unsafe ClientCurrentOrders client column name",
    };
  }
  try {
    if (clientKey) {
      const joined = await pool.request().query(`
        SELECT o.*, i.NAME_EN, i.CLE_CLIENT_NAME, i.I_DESC
        FROM ClientCurrentOrders o
        LEFT JOIN Investors i
          ON LTRIM(RTRIM(CAST(i.CL_CLIENT_ID AS nvarchar(32))))
           = LTRIM(RTRIM(CAST(o.[${clientKey}] AS nvarchar(32))))
      `);
      recordset = joined.recordset as Record<string, unknown>[];
    } else {
      const plain = await pool.request().query(`SELECT * FROM ClientCurrentOrders`);
      recordset = plain.recordset as Record<string, unknown>[];
    }
  } catch {
    const plain = await pool.request().query(`SELECT * FROM ClientCurrentOrders`);
    recordset = plain.recordset as Record<string, unknown>[];
  }

  let rows = recordset.map((row) => mapClientCurrentOrder(row, columns));
  const statusFilter = opts?.status?.trim().toUpperCase();
  if (statusFilter) {
    rows = rows.filter((r) => r.statusCode === statusFilter);
  }
  rows.sort((a, b) => String(b.orderDate || "").localeCompare(String(a.orderDate || "")) || a.orderNumber.localeCompare(b.orderNumber));

  return {
    polledAtIso,
    tableFound: true,
    columns,
    rows,
    warning: null,
  };
}
