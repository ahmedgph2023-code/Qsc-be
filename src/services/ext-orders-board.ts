/**
 * Investment Manager orders board (client brief, 19 Sep 2026).
 *
 * Three panels feed off two sources: the day's executions come from the same
 * ShareTransactions rows the Invoice Report uses, and the live order book comes
 * from ClientCurrentOrders. Every view is folded from one row set by the pure
 * functions below, so "by client", "by stock" and "by client and stock" cannot
 * drift apart.
 */
import { getInvoiceReport, type InvoiceReportRow } from "./ext-invoice-report.js";
import { listClientCurrentOrders, type ClientCurrentOrderRow } from "./ext-client-orders.js";
import { loadCash } from "./ext-sql-clients.js";
import { cashBalance } from "./ext-sql-portfolio.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The three groupings the Investment Manager switches between. */
export type ExecutionsView = "client_stock" | "stock" | "client";

export type ExecutionSummaryRow = {
  clientId: number | null;
  clientName: string | null;
  nin: string | null;
  ticker: string | null;
  companyName: string | null;
  buyQty: number;
  buyValue: number;
  /** Buy value ÷ buy quantity; null when nothing was bought. */
  avgBuyPrice: number | null;
  sellQty: number;
  sellValue: number;
  avgSellPrice: number | null;
  /** Buy value + sell value — the "total traded" column in the mockup. */
  totalValue: number;
};

export type ExecutionsTotals = Omit<ExecutionSummaryRow, "clientId" | "clientName" | "nin" | "ticker" | "companyName">;

export type ExecutionsSummary = {
  asOf: string;
  view: ExecutionsView;
  rows: ExecutionSummaryRow[];
  /** Per-client subtotals; only filled for the client + stock view. */
  clientSubtotals: ExecutionSummaryRow[];
  totals: ExecutionsTotals;
  executionCount: number;
};

type Bucket = {
  clientId: number | null;
  clientName: string | null;
  nin: string | null;
  ticker: string | null;
  companyName: string | null;
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
};

const avg = (value: number, qty: number) => (qty > 0 ? round4(value / qty) : null);

function finish(bucket: Bucket): ExecutionSummaryRow {
  const buyValue = round4(bucket.buyValue);
  const sellValue = round4(bucket.sellValue);
  return {
    clientId: bucket.clientId,
    clientName: bucket.clientName,
    nin: bucket.nin,
    ticker: bucket.ticker,
    companyName: bucket.companyName,
    buyQty: round4(bucket.buyQty),
    buyValue,
    avgBuyPrice: avg(bucket.buyValue, bucket.buyQty),
    sellQty: round4(bucket.sellQty),
    sellValue,
    avgSellPrice: avg(bucket.sellValue, bucket.sellQty),
    totalValue: round4(buyValue + sellValue),
  };
}

function fold(rows: InvoiceReportRow[], key: (row: InvoiceReportRow) => string, view: ExecutionsView): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const id = key(row);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        clientId: view === "stock" ? null : row.accountId,
        clientName: view === "stock" ? null : row.accountName,
        nin: view === "stock" ? null : row.nin || null,
        ticker: view === "client" ? null : row.ticker,
        companyName: view === "client" ? null : row.company,
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
      };
      buckets.set(id, bucket);
    }
    if (row.orderSide === "Buy") {
      bucket.buyQty += row.qty;
      bucket.buyValue += row.amount;
    } else {
      bucket.sellQty += row.qty;
      bucket.sellValue += row.amount;
    }
  }
  return [...buckets.values()];
}

function sumRows(rows: ExecutionSummaryRow[]): ExecutionsTotals {
  const buyQty = round4(rows.reduce((s, r) => s + r.buyQty, 0));
  const buyValue = round4(rows.reduce((s, r) => s + r.buyValue, 0));
  const sellQty = round4(rows.reduce((s, r) => s + r.sellQty, 0));
  const sellValue = round4(rows.reduce((s, r) => s + r.sellValue, 0));
  return {
    buyQty,
    buyValue,
    avgBuyPrice: avg(buyValue, buyQty),
    sellQty,
    sellValue,
    avgSellPrice: avg(sellValue, sellQty),
    totalValue: round4(buyValue + sellValue),
  };
}

/**
 * Folds one day of executions into the requested grouping. The grand total is
 * summed from the same rows in every view, which is what the reconciliation
 * test checks.
 */
export function summarizeExecutions(
  rows: InvoiceReportRow[],
  view: ExecutionsView,
  asOf: string,
): ExecutionsSummary {
  const keyOf: Record<ExecutionsView, (row: InvoiceReportRow) => string> = {
    client_stock: (r) => `${r.accountId}|${r.ticker.toUpperCase()}`,
    stock: (r) => r.ticker.toUpperCase(),
    client: (r) => String(r.accountId),
  };
  const summaryRows = fold(rows, keyOf[view], view).map(finish);

  summaryRows.sort((a, b) =>
    view === "stock"
      ? (a.ticker ?? "").localeCompare(b.ticker ?? "")
      : (a.clientName ?? "").localeCompare(b.clientName ?? "") || (a.ticker ?? "").localeCompare(b.ticker ?? ""),
  );

  // The mockup prints "إجمالي {client}" under each client block of the combined view.
  const clientSubtotals =
    view === "client_stock" ? fold(rows, (r) => String(r.accountId), "client").map(finish) : [];
  clientSubtotals.sort((a, b) => (a.clientName ?? "").localeCompare(b.clientName ?? ""));

  return {
    asOf,
    view,
    rows: summaryRows,
    clientSubtotals,
    totals: sumRows(view === "client_stock" ? clientSubtotals : summaryRows),
    executionCount: rows.length,
  };
}

export async function getDailyExecutions(asOf: string, view: ExecutionsView): Promise<ExecutionsSummary> {
  const report = await getInvoiceReport({ from: asOf, to: asOf });
  return summarizeExecutions(report.rows, view, asOf);
}

/** Statuses that still sit in the market: Active and Partially Executed. */
export const OPEN_ORDER_STATUSES = new Set(["A", "P"]);

export type PendingBoardRow = {
  ticker: string;
  companyName: string | null;
  side: "Buy" | "Sell";
  /** Number of live orders collapsed into this row — the "(n)" in the mockup. */
  orderCount: number;
  qty: number;
  executedQty: number;
  remainQty: number;
};

export type PendingBoard = {
  polledAtIso: string;
  rows: PendingBoardRow[];
  buyOrderCount: number;
  sellOrderCount: number;
  warning: string | null;
};

export const isOpenOrder = (row: ClientCurrentOrderRow) => OPEN_ORDER_STATUSES.has(row.statusCode);

/** Remaining is taken from SQL when present, else derived from total − executed. */
export function remainingOf(row: ClientCurrentOrderRow): number {
  if (row.remainingQty != null) return row.remainingQty;
  return Math.max(0, (row.totalQty ?? 0) - (row.executedQty ?? 0));
}

/** Collapses live orders to one row per symbol × side, as the mockup board shows. */
export function buildPendingBoard(orders: ClientCurrentOrderRow[]): PendingBoardRow[] {
  const buckets = new Map<string, PendingBoardRow>();
  for (const order of orders) {
    if (!isOpenOrder(order)) continue;
    if (order.orderType !== "Buy" && order.orderType !== "Sell") continue;
    const ticker = order.ticker.toUpperCase();
    const key = `${ticker}|${order.orderType}`;
    const row = buckets.get(key) ?? {
      ticker: order.ticker,
      companyName: order.companyName,
      side: order.orderType,
      orderCount: 0,
      qty: 0,
      executedQty: 0,
      remainQty: 0,
    };
    row.orderCount += 1;
    row.qty += order.totalQty ?? 0;
    row.executedQty += order.executedQty ?? 0;
    row.remainQty += remainingOf(order);
    row.companyName = row.companyName || order.companyName;
    buckets.set(key, row);
  }
  return [...buckets.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.side.localeCompare(b.side),
  );
}

/** Filter bar of the detailed "الأوامر التفصيلية" table. */
export type OrderListFilters = {
  orderType?: "all" | "buy" | "sell";
  ticker?: string | null;
  status?: string | null;
  validity?: string | null;
  orderNo?: string | null;
  clientId?: number | null;
  /** Free text over client name, NIN, ticker, company and order number. */
  q?: string | null;
};

/** `Daily` / `Date` — the validity token the filter dropdown sends. */
export const validityKey = (row: ClientCurrentOrderRow) => row.validity.kind;

const has = (haystack: string | null | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle);

export function filterOrders(rows: ClientCurrentOrderRow[], filters: OrderListFilters): ClientCurrentOrderRow[] {
  const side = filters.orderType && filters.orderType !== "all" ? filters.orderType : null;
  const ticker = filters.ticker?.trim().toUpperCase() || null;
  const status = filters.status?.trim().toUpperCase() || null;
  const validity = filters.validity?.trim().toLowerCase() || null;
  const orderNo = filters.orderNo?.trim().toLowerCase() || null;
  const q = filters.q?.trim().toLowerCase() || null;

  return rows.filter((row) => {
    if (side && row.orderType.toLowerCase() !== side) return false;
    if (ticker && row.ticker.toUpperCase() !== ticker) return false;
    if (status && row.statusCode !== status) return false;
    if (validity && validityKey(row).toLowerCase() !== validity) return false;
    if (orderNo && !row.orderNumber.toLowerCase().includes(orderNo)) return false;
    if (filters.clientId != null && row.clientId !== filters.clientId) return false;
    if (
      q &&
      !(
        has(row.clientName, q) ||
        has(row.nin, q) ||
        has(row.ticker, q) ||
        has(row.companyName, q) ||
        has(row.orderNumber, q)
      )
    ) {
      return false;
    }
    return true;
  });
}

export type OrderListResult = {
  polledAtIso: string;
  tableFound: boolean;
  rows: ClientCurrentOrderRow[];
  /** `n من total` in the mockup: matched rows out of every live order. */
  total: number;
  filtered: number;
  options: {
    tickers: string[];
    statuses: Array<{ code: string; label: string }>;
    validities: string[];
  };
  warning: string | null;
};

/** Dropdown contents come from the live book, so no dead options are offered. */
function orderListOptions(rows: ClientCurrentOrderRow[]): OrderListResult["options"] {
  const statuses = new Map<string, string>();
  for (const row of rows) if (row.statusCode) statuses.set(row.statusCode, row.statusLabel);
  return {
    tickers: [...new Set(rows.map((r) => r.ticker).filter((t) => t && t !== "—"))].sort(),
    statuses: [...statuses.entries()]
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    validities: [...new Set(rows.map(validityKey))].sort(),
  };
}

export async function getOrderList(filters: OrderListFilters): Promise<OrderListResult> {
  const orders = await listClientCurrentOrders();
  const rows = filterOrders(orders.rows, filters);
  return {
    polledAtIso: orders.polledAtIso,
    tableFound: orders.tableFound,
    rows,
    total: orders.rows.length,
    filtered: rows.length,
    options: orderListOptions(orders.rows),
    warning: orders.warning,
  };
}

export type BoardClient = { clientId: number; clientName: string; nin: string | null };

export type AvailableBalanceRow = BoardClient & {
  /** Cash ledger balance as of the board date — see `balanceBasis`. */
  balance: number;
  hasOpenOrders: boolean;
  executedToday: boolean;
};

export type AvailableBalances = {
  asOf: string;
  /**
   * The client has not yet confirmed whether "available" nets off open buy
   * orders (Q6), so the figure is the cash ledger balance and the UI says so.
   */
  balanceBasis: "cash_ledger";
  rows: AvailableBalanceRow[];
  totalBalance: number;
  warning: string | null;
};

/**
 * Everyone the manager can see on the board: clients with a live order plus
 * clients who traded today.
 */
export function unionBoardClients(
  orders: ClientCurrentOrderRow[],
  executions: InvoiceReportRow[],
): Array<BoardClient & { hasOpenOrders: boolean; executedToday: boolean }> {
  const byId = new Map<number, BoardClient & { hasOpenOrders: boolean; executedToday: boolean }>();
  const upsert = (clientId: number, name: string, nin: string | null, key: "hasOpenOrders" | "executedToday") => {
    const existing = byId.get(clientId);
    if (existing) {
      existing[key] = true;
      existing.clientName = existing.clientName || name;
      existing.nin = existing.nin || nin;
      return;
    }
    byId.set(clientId, {
      clientId,
      clientName: name,
      nin,
      hasOpenOrders: key === "hasOpenOrders",
      executedToday: key === "executedToday",
    });
  };

  for (const order of orders) {
    if (!isOpenOrder(order) || order.clientId == null) continue;
    upsert(order.clientId, order.clientName, order.nin, "hasOpenOrders");
  }
  for (const row of executions) {
    if (!row.accountId) continue;
    upsert(row.accountId, row.accountName, row.nin || null, "executedToday");
  }
  return [...byId.values()].sort((a, b) => a.clientName.localeCompare(b.clientName) || a.clientId - b.clientId);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

export async function getAvailableBalances(asOf: string): Promise<AvailableBalances> {
  const [orders, executions] = await Promise.all([
    listClientCurrentOrders(),
    getInvoiceReport({ from: asOf, to: asOf }),
  ]);
  const clients = unionBoardClients(orders.rows, executions.rows);
  const rows = await mapPool(clients, 4, async (client) => ({
    ...client,
    balance: cashBalance(await loadCash(client.clientId, asOf), asOf),
  }));
  return {
    asOf,
    balanceBasis: "cash_ledger",
    rows,
    totalBalance: round4(rows.reduce((s, r) => s + r.balance, 0)),
    warning: orders.warning,
  };
}

export async function getPendingBoard(): Promise<PendingBoard> {
  const orders = await listClientCurrentOrders();
  const open = orders.rows.filter(isOpenOrder);
  return {
    polledAtIso: orders.polledAtIso,
    rows: buildPendingBoard(orders.rows),
    buyOrderCount: open.filter((o) => o.orderType === "Buy").length,
    sellOrderCount: open.filter((o) => o.orderType === "Sell").length,
    warning: orders.warning,
  };
}
