/** Firm portfolio Excel + PDF exports — header lines, columns, page fit. */
import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

vi.mock("./ext-sql-clients.js", () => ({
  getPortfolioStatement: vi.fn(),
  getRealizedSummaryStatement: vi.fn(),
}));

vi.mock("../db/mssql.js", () => ({
  getMssqlPool: vi.fn(),
  sql: { Date: "Date", Int: "Int", NVarChar: () => "NVarChar" },
}));

import {
  firmHoldersHeaderLines,
  firmPortfolioHeaderLines,
  type FirmPortfolioDrilldown,
  type FirmPortfolioResult,
} from "./ext-firm-portfolio.js";
import { firmHoldersWorkbook, firmPortfolioWorkbook } from "./firm-portfolio-excel.js";
import {
  FIRM_HOLDER_COLUMNS,
  FIRM_PDF_PRINTABLE_WIDTH,
  FIRM_STOCK_COLUMNS,
  firmHoldersPdf,
  firmPortfolioPdf,
} from "./firm-portfolio-pdf.js";

const report: FirmPortfolioResult = {
  asOf: "2026-09-19",
  accountTypeFilter: "INV PORT",
  clientCount: 2,
  stocks: [
    {
      ticker: "QNBK",
      companyName: "QNB",
      sector: "Banks",
      securityNumber: null,
      clientCount: 2,
      totalQuantity: 1500,
      totalCost: 12000,
      marketPrice: 16.125,
      marketValue: 24187.5,
      unrealizedPl: 12187.5,
      returnPct: 101.56,
      realizedPl: 300,
      stockPct: 75,
      sectorPct: 75,
    },
    {
      ticker: "IQCD",
      companyName: "Industries Qatar",
      sector: "Industrials",
      securityNumber: null,
      clientCount: 1,
      totalQuantity: 500,
      totalCost: 7000,
      marketPrice: 16.125,
      marketValue: 8062.5,
      unrealizedPl: 1062.5,
      returnPct: 15.18,
      realizedPl: 0,
      stockPct: 25,
      sectorPct: 25,
    },
  ],
  sectors: [
    {
      sector: "Banks",
      stockCount: 1,
      totalCost: 12000,
      marketValue: 24187.5,
      unrealizedPl: 12187.5,
      realizedPl: 300,
      sectorPct: 75,
    },
    {
      sector: "Industrials",
      stockCount: 1,
      totalCost: 7000,
      marketValue: 8062.5,
      unrealizedPl: 1062.5,
      realizedPl: 0,
      sectorPct: 25,
    },
  ],
  totals: {
    totalQuantity: 2000,
    totalCost: 19000,
    marketValue: 32250,
    unrealizedPl: 13250,
    realizedPl: 300,
  },
};

const drill: FirmPortfolioDrilldown = {
  asOf: "2026-09-19",
  ticker: "QNBK",
  companyName: "QNB",
  sector: "Banks",
  marketPrice: 16.125,
  holders: [
    {
      ticker: "QNBK",
      companyName: "QNB",
      sector: "Banks",
      clientId: 2041929,
      clientName: "AHMED",
      nin: "37808",
      quantity: 1000,
      cost: 8000,
      costPrice: 8,
      marketPrice: 16.125,
      marketValue: 16125,
      unrealizedPl: 8125,
      returnPct: 101.56,
      realizedPl: 200,
      holderPct: 66.67,
    },
    {
      ticker: "QNBK",
      companyName: "QNB",
      sector: "Banks",
      clientId: 2041933,
      clientName: "FAHAD",
      nin: "47016",
      quantity: 500,
      cost: 4000,
      costPrice: 8,
      marketPrice: 16.125,
      marketValue: 8062.5,
      unrealizedPl: 4062.5,
      returnPct: 101.56,
      realizedPl: 100,
      holderPct: 33.33,
    },
  ],
  totals: {
    totalQuantity: 1500,
    totalCost: 12000,
    marketValue: 24187.5,
    unrealizedPl: 12187.5,
    realizedPl: 300,
  },
};

async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
}

const sheetText = (ws: ExcelJS.Worksheet) => {
  const lines: string[] = [];
  ws.eachRow((row) => lines.push(row.values ? String(row.values) : ""));
  return lines.join("\n");
};

describe("firmPortfolioHeaderLines", () => {
  it("states the as-of date, account type and counts", () => {
    expect(firmPortfolioHeaderLines(report).map((l) => `${l.label}: ${l.value}`)).toEqual([
      "As of: 19/09/2026",
      "Account Type: INV PORT",
      "Clients: 2",
      "Stocks: 2",
    ]);
  });
});

describe("firmHoldersHeaderLines", () => {
  it("names the stock and prints its price at three decimals", () => {
    const values = Object.fromEntries(firmHoldersHeaderLines(drill).map((l) => [l.label, l.value]));
    expect(values.Stock).toBe("QNBK — QNB");
    expect(values.Sector).toBe("Banks");
    expect(values["Market Price"]).toBe("16.125");
    expect(values.Holders).toBe("2");
  });
});

describe("firmPortfolioWorkbook", () => {
  it("writes a portfolio sheet with sector and weight columns, plus a sector sheet", async () => {
    const { filename, buffer } = await firmPortfolioWorkbook(report);
    expect(filename).toBe("FirmPortfolio_2026-09-19.xlsx");

    const workbook = await read(buffer);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(["Portfolio", "Sectors"]);

    const stocks = workbook.getWorksheet("Portfolio")!;
    const text = sheetText(stocks);
    expect(text).toContain("As of: 19/09/2026");
    expect(text).toContain("Sector");
    expect(text).toContain("Stock %");
    expect(text).toContain("QNBK");
    expect(stocks.getImages().length).toBeGreaterThan(0);

    expect(sheetText(workbook.getWorksheet("Sectors")!)).toContain("Industrials");
  });

  it("formats market price with three decimals and values with two", async () => {
    const { buffer } = await firmPortfolioWorkbook(report);
    const ws = (await read(buffer)).getWorksheet("Portfolio")!;
    const header = ws.getRow(ws.rowCount - report.stocks.length - 1);
    const headers = (header.values as unknown[]).slice(1).map(String);
    const firstDataRow = ws.getRow(header.number + 1);
    const priceCell = firstDataRow.getCell(headers.indexOf("Market Price") + 1);
    const valueCell = firstDataRow.getCell(headers.indexOf("Market Value") + 1);
    expect(priceCell.numFmt).toBe("#,##0.000");
    expect(valueCell.numFmt).toBe("#,##0.00");
  });
});

describe("firmHoldersWorkbook", () => {
  it("lists every holder with its share of the stock", async () => {
    const { filename, buffer } = await firmHoldersWorkbook(drill);
    expect(filename).toBe("StockHolders_QNBK_2026-09-19.xlsx");
    const text = sheetText((await read(buffer)).getWorksheet("Holders")!);
    expect(text).toContain("Stock: QNBK — QNB");
    expect(text).toContain("Share of Stock %");
    expect(text).toContain("AHMED");
    expect(text).toContain("FAHAD");
  });
});

describe("firm portfolio PDFs", () => {
  // A wider table than the page silently drops the last columns.
  it("keeps both tables inside the printable width", () => {
    const width = (cols: Array<{ w: number }>) => cols.reduce((s, c) => s + c.w, 0);
    expect(width(FIRM_STOCK_COLUMNS)).toBeLessThanOrEqual(FIRM_PDF_PRINTABLE_WIDTH);
    expect(width(FIRM_HOLDER_COLUMNS)).toBeLessThanOrEqual(FIRM_PDF_PRINTABLE_WIDTH);
  });

  it("produces PDFs named for the as-of date", async () => {
    const list = await firmPortfolioPdf(report);
    expect(list.filename).toBe("FirmPortfolio_2026-09-19.pdf");
    expect(list.buffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(list.buffer.length).toBeGreaterThan(1000);

    const holders = await firmHoldersPdf(drill);
    expect(holders.filename).toBe("StockHolders_QNBK_2026-09-19.pdf");
    expect(holders.buffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
});
