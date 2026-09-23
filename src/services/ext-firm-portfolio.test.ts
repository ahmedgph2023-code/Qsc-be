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
  aggregateFirmSectors,
  returnPctFromUnrealized,
  sumFirmStocks,
  withHolderWeights,
  type FirmPortfolioHolder,
} from "./ext-firm-portfolio.js";

function holder(partial: Partial<FirmPortfolioHolder>): FirmPortfolioHolder {
  return {
    ticker: "QNBK",
    companyName: "QNB",
    sector: "Banks",
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
    holderPct: null,
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

  it("carries the sector from the client statement lines", () => {
    const stocks = aggregateFirmHolders([
      holder({ ticker: "QNBK", sector: null }),
      holder({ ticker: "QNBK", clientId: 2, sector: "Banks" }),
    ]);
    expect(stocks[0]?.sector).toBe("Banks");
  });
});

describe("firm weights", () => {
  const stocks = () =>
    aggregateFirmHolders([
      holder({ ticker: "QNBK", sector: "Banks", marketValue: 600, cost: 500, unrealizedPl: 100 }),
      holder({ ticker: "QIBK", sector: "Banks", marketValue: 200, cost: 150, unrealizedPl: 50 }),
      holder({ ticker: "IQCD", sector: "Industrials", marketValue: 200, cost: 250, unrealizedPl: -50 }),
    ]);

  it("gives each stock its share of firm market value", () => {
    const byTicker = Object.fromEntries(stocks().map((s) => [s.ticker, s]));
    expect(byTicker.QNBK!.stockPct).toBe(60);
    expect(byTicker.QIBK!.stockPct).toBe(20);
    expect(byTicker.IQCD!.stockPct).toBe(20);
  });

  it("repeats the sector share on every stock of that sector", () => {
    const byTicker = Object.fromEntries(stocks().map((s) => [s.ticker, s]));
    expect(byTicker.QNBK!.sectorPct).toBe(80);
    expect(byTicker.QIBK!.sectorPct).toBe(80);
    expect(byTicker.IQCD!.sectorPct).toBe(20);
  });

  it("stock percentages add up to 100", () => {
    const total = stocks().reduce((s, r) => s + (r.stockPct ?? 0), 0);
    expect(total).toBeCloseTo(100, 4);
  });

  it("leaves percentages null when nothing is valued", () => {
    const unpriced = aggregateFirmHolders([holder({ marketValue: null, unrealizedPl: null })]);
    expect(unpriced[0]?.stockPct).toBeNull();
    expect(unpriced[0]?.sectorPct).toBeNull();
  });
});

describe("aggregateFirmSectors", () => {
  it("rolls stocks into sectors, biggest first, summing to 100%", () => {
    const sectors = aggregateFirmSectors(
      aggregateFirmHolders([
        holder({ ticker: "QNBK", sector: "Banks", marketValue: 600, cost: 500, unrealizedPl: 100 }),
        holder({ ticker: "QIBK", sector: "Banks", marketValue: 200, cost: 150, unrealizedPl: 50 }),
        holder({ ticker: "IQCD", sector: "Industrials", marketValue: 200, cost: 250, unrealizedPl: -50 }),
      ]),
    );
    expect(sectors.map((s) => s.sector)).toEqual(["Banks", "Industrials"]);
    expect(sectors[0]).toMatchObject({ stockCount: 2, marketValue: 800, sectorPct: 80 });
    expect(sectors[1]).toMatchObject({ stockCount: 1, marketValue: 200, sectorPct: 20 });
    expect(sectors.reduce((s, r) => s + (r.sectorPct ?? 0), 0)).toBeCloseTo(100, 4);
  });

  it("groups stocks with no sector under Unclassified", () => {
    const sectors = aggregateFirmSectors(aggregateFirmHolders([holder({ sector: null })]));
    expect(sectors[0]?.sector).toBe("Unclassified");
  });
});

describe("withHolderWeights", () => {
  it("splits one stock across its holders, summing to 100%", () => {
    const holders = withHolderWeights([
      holder({ clientId: 1, marketValue: 750 }),
      holder({ clientId: 2, marketValue: 250 }),
    ]);
    expect(holders.map((h) => h.holderPct)).toEqual([75, 25]);
    expect(holders.reduce((s, h) => s + (h.holderPct ?? 0), 0)).toBeCloseTo(100, 4);
  });

  it("leaves the share null when the holding is unpriced", () => {
    const holders = withHolderWeights([holder({ marketValue: null })]);
    expect(holders[0]?.holderPct).toBeNull();
  });
});
