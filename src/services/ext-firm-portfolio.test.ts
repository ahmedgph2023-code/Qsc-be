import { describe, expect, it, vi } from "vitest";

vi.mock("./ext-sql-clients.js", () => ({
  getPortfolioStatement: vi.fn(),
  getRealizedSummaryStatement: vi.fn(),
}));

vi.mock("../db/mssql.js", () => ({
  getMssqlPool: vi.fn(),
  sql: { Date: "Date", Int: "Int", NVarChar: () => "NVarChar" },
}));

import {
  aggregateFirmHolders,
  returnPctFromUnrealized,
  sumFirmStocks,
  type FirmPortfolioHolder,
} from "./ext-firm-portfolio.js";

function holder(partial: Partial<FirmPortfolioHolder>): FirmPortfolioHolder {
  return {
    ticker: "QNBK",
    companyName: "QNB",
    clientId: 1,
    clientName: "A",
    nin: "1",
    quantity: 100,
    cost: 1000,
    costPrice: 10,
    marketPrice: 12,
    marketValue: 1200,
    unrealizedPl: 200,
    returnPct: 20,
    realizedPl: 50,
    ...partial,
  };
}

describe("returnPctFromUnrealized", () => {
  it("uses Unrealized ÷ Cost × 100", () => {
    expect(returnPctFromUnrealized(200, 1000)).toBe(20);
    expect(returnPctFromUnrealized(null, 1000)).toBeNull();
    expect(returnPctFromUnrealized(10, 0)).toBeNull();
  });
});

describe("aggregateFirmHolders", () => {
  it("sums qty/cost/mv/pl across clients and matches Σ", () => {
    const holders = [
      holder({ clientId: 1, quantity: 100, cost: 1000, marketValue: 1200, unrealizedPl: 200, realizedPl: 10 }),
      holder({ clientId: 2, quantity: 50, cost: 400, marketValue: 600, unrealizedPl: 200, realizedPl: 5 }),
    ];
    const stocks = aggregateFirmHolders(holders);
    expect(stocks).toHaveLength(1);
    const s = stocks[0]!;
    expect(s.clientCount).toBe(2);
    expect(s.totalQuantity).toBe(150);
    expect(s.totalCost).toBe(1400);
    expect(s.marketValue).toBe(1800);
    expect(s.unrealizedPl).toBe(400);
    expect(s.realizedPl).toBe(15);
    expect(s.returnPct).toBeCloseTo((400 / 1400) * 100, 4);
    const totals = sumFirmStocks(stocks);
    expect(totals.totalQuantity).toBe(s.totalQuantity);
    expect(totals.totalCost).toBe(s.totalCost);
  });
});
