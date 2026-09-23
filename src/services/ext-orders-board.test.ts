/** Orders board engine — the three executions views must reconcile. */
import { describe, expect, it, vi } from "vitest";

vi.mock("./ext-sql-clients.js", () => ({ loadCash: vi.fn() }));

vi.mock("../db/mssql.js", () => ({
  getMssqlPool: vi.fn(),
  sql: { Date: "Date", Int: "Int", BigInt: "BigInt", NVarChar: () => "NVarChar" },
}));

import {
  buildPendingBoard,
  filterOrders,
  remainingOf,
  summarizeExecutions,
  unionBoardClients,
  type ExecutionsView,
} from "./ext-orders-board.js";
import type { InvoiceReportRow } from "./ext-invoice-report.js";
import type { ClientCurrentOrderRow } from "./ext-client-orders.js";

function execution(partial: Partial<InvoiceReportRow>): InvoiceReportRow {
  return {
    invSequence: 1,
    invNo: 1,
    orderSide: "Buy",
    invType: "OI",
    accountId: 2041929,
    nin: "37808",
    accountName: "AHMED",
    ticker: "QNBK",
    company: "QNB",
    market: "QATAR STOCK EXCHANGE",
    tradeDate: "2026-09-19",
    qty: 100,
    priceAvg: 16,
    amount: 1600,
    totalComm: 0,
    officeComm: 0,
    marketComm: 0,
    net: 1600,
    ...partial,
  };
}

const rows: InvoiceReportRow[] = [
  execution({ accountId: 1, accountName: "AHMED", ticker: "QNBK", qty: 100, amount: 1600, orderSide: "Buy" }),
  execution({ accountId: 1, accountName: "AHMED", ticker: "QNBK", qty: 100, amount: 1800, orderSide: "Buy" }),
  execution({ accountId: 1, accountName: "AHMED", ticker: "IQCD", qty: 50, amount: 750, orderSide: "Sell", invType: "OC" }),
  execution({ accountId: 2, accountName: "FAHAD", ticker: "QNBK", qty: 200, amount: 3400, orderSide: "Sell", invType: "OC" }),
];

const views: ExecutionsView[] = ["client_stock", "stock", "client"];

describe("summarizeExecutions", () => {
  it("averages price as value ÷ quantity per side", () => {
    const summary = summarizeExecutions(rows, "client_stock", "2026-09-19");
    const ahmedQnbk = summary.rows.find((r) => r.clientId === 1 && r.ticker === "QNBK")!;
    expect(ahmedQnbk.buyQty).toBe(200);
    expect(ahmedQnbk.buyValue).toBe(3400);
    expect(ahmedQnbk.avgBuyPrice).toBe(17);
    expect(ahmedQnbk.sellQty).toBe(0);
    expect(ahmedQnbk.avgSellPrice).toBeNull();
    expect(ahmedQnbk.totalValue).toBe(3400);
  });

  it("gives the same grand total in all three views", () => {
    const totals = views.map((view) => summarizeExecutions(rows, view, "2026-09-19").totals);
    for (const t of totals) {
      expect(t.buyValue).toBe(3400);
      expect(t.sellValue).toBe(4150);
      expect(t.buyQty).toBe(200);
      expect(t.sellQty).toBe(250);
      expect(t.totalValue).toBe(7550);
    }
    expect(new Set(totals.map((t) => JSON.stringify(t))).size).toBe(1);
  });

  it("groups one row per stock in the stock view and drops the client", () => {
    const summary = summarizeExecutions(rows, "stock", "2026-09-19");
    expect(summary.rows.map((r) => r.ticker)).toEqual(["IQCD", "QNBK"]);
    expect(summary.rows.every((r) => r.clientId === null)).toBe(true);
    const qnbk = summary.rows.find((r) => r.ticker === "QNBK")!;
    expect(qnbk.buyValue).toBe(3400);
    expect(qnbk.sellValue).toBe(3400);
  });

  it("groups one row per client in the client view and drops the stock", () => {
    const summary = summarizeExecutions(rows, "client", "2026-09-19");
    expect(summary.rows.map((r) => r.clientName)).toEqual(["AHMED", "FAHAD"]);
    expect(summary.rows.every((r) => r.ticker === null)).toBe(true);
  });

  it("adds a subtotal per client only in the combined view", () => {
    const combined = summarizeExecutions(rows, "client_stock", "2026-09-19");
    expect(combined.clientSubtotals.map((r) => r.clientName)).toEqual(["AHMED", "FAHAD"]);
    expect(combined.clientSubtotals[0]!.totalValue).toBe(4150);
    expect(summarizeExecutions(rows, "stock", "2026-09-19").clientSubtotals).toEqual([]);
  });

  it("returns empty totals for a day with no executions", () => {
    const summary = summarizeExecutions([], "client_stock", "2026-09-19");
    expect(summary.rows).toEqual([]);
    expect(summary.totals.totalValue).toBe(0);
    expect(summary.totals.avgBuyPrice).toBeNull();
    expect(summary.executionCount).toBe(0);
  });
});

function order(partial: Partial<ClientCurrentOrderRow>): ClientCurrentOrderRow {
  return {
    orderNumber: "1",
    orderType: "Buy",
    clientId: 1,
    clientName: "AHMED",
    nin: "37808",
    ticker: "QNBK",
    companyName: "QNB",
    statusCode: "A",
    statusLabel: "Active",
    orderDate: "2026-09-19",
    totalQty: 1000,
    remainingQty: null,
    executedQty: 0,
    displayedQty: null,
    orderValue: null,
    validity: { kind: "Daily" },
    raw: {},
    ...partial,
  };
}

describe("remainingOf", () => {
  it("prefers the SQL remaining column", () => {
    expect(remainingOf(order({ remainingQty: 250, totalQty: 1000, executedQty: 400 }))).toBe(250);
  });

  it("falls back to total − executed, never negative", () => {
    expect(remainingOf(order({ remainingQty: null, totalQty: 1000, executedQty: 400 }))).toBe(600);
    expect(remainingOf(order({ remainingQty: null, totalQty: 100, executedQty: 400 }))).toBe(0);
  });
});

describe("filterOrders", () => {
  const book = [
    order({ orderNumber: "100", ticker: "QNBK", orderType: "Buy", statusCode: "A", clientId: 1, clientName: "AHMED" }),
    order({
      orderNumber: "200",
      ticker: "IQCD",
      companyName: "Industries Qatar",
      orderType: "Sell",
      statusCode: "P",
      clientId: 2,
      clientName: "FAHAD",
      nin: "47016",
      validity: { kind: "Date", until: "2026-12-31" },
    }),
  ];

  it("filters by side, symbol, status, validity and client", () => {
    expect(filterOrders(book, { orderType: "buy" }).map((r) => r.orderNumber)).toEqual(["100"]);
    expect(filterOrders(book, { ticker: "iqcd" }).map((r) => r.orderNumber)).toEqual(["200"]);
    expect(filterOrders(book, { status: "P" }).map((r) => r.orderNumber)).toEqual(["200"]);
    expect(filterOrders(book, { validity: "Daily" }).map((r) => r.orderNumber)).toEqual(["100"]);
    expect(filterOrders(book, { clientId: 2 }).map((r) => r.orderNumber)).toEqual(["200"]);
  });

  it("matches the order number partially and searches name, NIN and ticker", () => {
    expect(filterOrders(book, { orderNo: "20" }).map((r) => r.orderNumber)).toEqual(["200"]);
    expect(filterOrders(book, { q: "fahad" }).map((r) => r.orderNumber)).toEqual(["200"]);
    expect(filterOrders(book, { q: "47016" }).map((r) => r.orderNumber)).toEqual(["200"]);
    expect(filterOrders(book, { q: "qnb" }).map((r) => r.orderNumber)).toEqual(["100"]);
  });

  it("combines filters and returns everything when unset", () => {
    expect(filterOrders(book, { orderType: "all", ticker: null, q: "" })).toHaveLength(2);
    expect(filterOrders(book, { orderType: "buy", ticker: "IQCD" })).toHaveLength(0);
  });
});

describe("unionBoardClients", () => {
  it("merges clients with live orders and clients who traded today", () => {
    const clients = unionBoardClients(
      [
        order({ clientId: 1, clientName: "AHMED", statusCode: "A" }),
        order({ clientId: 3, clientName: "SARA", statusCode: "C" }),
      ],
      [execution({ accountId: 2, accountName: "FAHAD", nin: "47016" })],
    );
    expect(clients.map((c) => c.clientName)).toEqual(["AHMED", "FAHAD"]);
    expect(clients.find((c) => c.clientId === 1)).toMatchObject({ hasOpenOrders: true, executedToday: false });
    expect(clients.find((c) => c.clientId === 2)).toMatchObject({ hasOpenOrders: false, executedToday: true });
  });

  it("marks a client who both has an order and traded today", () => {
    const clients = unionBoardClients(
      [order({ clientId: 1, clientName: "AHMED", statusCode: "A" })],
      [execution({ accountId: 1, accountName: "AHMED" })],
    );
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ hasOpenOrders: true, executedToday: true });
  });
});

describe("buildPendingBoard", () => {
  it("collapses live orders to one row per symbol and side", () => {
    const board = buildPendingBoard([
      order({ orderNumber: "1", ticker: "QNBK", orderType: "Buy", totalQty: 1000, executedQty: 200 }),
      order({ orderNumber: "2", ticker: "QNBK", orderType: "Buy", totalQty: 500, executedQty: 0 }),
      order({ orderNumber: "3", ticker: "QNBK", orderType: "Sell", totalQty: 300, executedQty: 0 }),
    ]);
    expect(board).toHaveLength(2);
    const buy = board.find((r) => r.side === "Buy")!;
    expect(buy.orderCount).toBe(2);
    expect(buy.qty).toBe(1500);
    expect(buy.executedQty).toBe(200);
    expect(buy.remainQty).toBe(1300);
  });

  it("keeps only orders that are still in the market", () => {
    const board = buildPendingBoard([
      order({ orderNumber: "1", statusCode: "S" }),
      order({ orderNumber: "2", statusCode: "C" }),
      order({ orderNumber: "3", statusCode: "P", totalQty: 400, executedQty: 100 }),
    ]);
    expect(board).toHaveLength(1);
    expect(board[0]!.orderCount).toBe(1);
    expect(board[0]!.remainQty).toBe(300);
  });
});
