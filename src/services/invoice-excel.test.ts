/**
 * Invoice Report Excel — agreed with the client on 19 Sep 2026: embedded logo,
 * selected filters in the header, Invoice Sequence and Invoice Number as
 * distinct columns, no Buy Qty / Sell Qty / Account Type / Account ID, and
 * prices at three decimals.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { invoiceReportWorkbook } from "./invoice-excel.js";
import type { InvoiceReportResult, InvoiceReportRow } from "./ext-invoice-report.js";

const row: InvoiceReportRow = {
  invSequence: 4471,
  invNo: 323860,
  orderSide: "Buy",
  invType: "OI",
  accountId: 2041933,
  nin: "47016",
  accountName: "FAHAD",
  ticker: "DBIS",
  company: "DLALA",
  market: "QATAR STOCK EXCHANGE",
  tradeDate: "2026-09-09",
  qty: 600000,
  priceAvg: 1.581,
  amount: 948649.005,
  totalComm: 2608.78,
  officeComm: 1992.16,
  marketComm: 616.62,
  net: 951257.79,
};

const report: InvoiceReportResult = {
  title: "Customer Invoices",
  from: "2026-09-01",
  to: "2026-09-15",
  filters: { clientId: null, clientName: null, ticker: null, orderType: "all", invNo: null },
  rows: [row],
  totals: {
    amount: 948649.005,
    totalComm: 2608.78,
    officeComm: 1992.16,
    marketComm: 616.62,
    net: 951257.79,
    qty: 600000,
    count: 1,
  },
};

async function sheetOf(result: InvoiceReportResult) {
  const { buffer } = await invoiceReportWorkbook(result);
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types its loader against its own Buffer alias (an ArrayBuffer).
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return { workbook, ws: workbook.worksheets[0]! };
}

function headerCells(ws: ExcelJS.Worksheet): string[] {
  let headers: string[] = [];
  ws.eachRow((r) => {
    const values = (r.values as Array<unknown>).slice(1).map((v) => String(v ?? ""));
    if (values[0] === "Invoice Sequence") headers = values;
  });
  return headers;
}

function sheetText(ws: ExcelJS.Worksheet): string {
  const lines: string[] = [];
  ws.eachRow((r) => lines.push((r.values as Array<unknown>).slice(1).map((v) => String(v ?? "")).join(" | ")));
  return lines.join("\n");
}

describe("invoiceReportWorkbook", () => {
  it("lists Invoice Sequence and Invoice Number as separate columns", async () => {
    const headers = headerCells((await sheetOf(report)).ws);
    expect(headers[0]).toBe("Invoice Sequence");
    expect(headers[1]).toBe("Invoice Number");
  });

  it("drops the columns the client removed", async () => {
    const headers = headerCells((await sheetOf(report)).ws);
    for (const dropped of ["Buy Qty", "Sell Qty", "Account Type", "Account ID"]) {
      expect(headers).not.toContain(dropped);
    }
    expect(headers).toContain("NIN");
    expect(headers).toContain("Account Name");
  });

  it("embeds the company logo", async () => {
    const { workbook, ws } = await sheetOf(report);
    expect(ws.getImages().length).toBe(1);
    expect(workbook.model.media.length).toBeGreaterThan(0);
  });

  it("prints the selected filters above the table", async () => {
    const { ws } = await sheetOf({
      ...report,
      filters: { clientId: 2041933, clientName: "FAHAD", ticker: "QNBK", orderType: "sell", invNo: 323860 },
    });
    const text = sheetText(ws);
    expect(text).toContain("Qatar Securities Co. (P.Q.S.C)");
    expect(text).toContain("Invoice Report");
    expect(text).toContain("Period: 01/09/2026 – 15/09/2026");
    expect(text).toContain("Customer: FAHAD (2041933)");
    expect(text).toContain("Stock: QNBK");
    expect(text).toContain("Order Type: Sell");
    expect(text).toContain("Invoice: 323860");
  });

  it("says All when a filter is not used", async () => {
    const text = sheetText((await sheetOf(report)).ws);
    expect(text).toContain("Customer: All Customers");
    expect(text).toContain("Stock: All Stocks");
    expect(text).toContain("Order Type: All");
    expect(text).toContain("Invoice: All Invoices");
  });

  it("writes the average price with three decimals", async () => {
    const { ws } = await sheetOf(report);
    const headers = headerCells(ws);
    const priceCol = headers.indexOf("Price Avg.") + 1;
    let priceCell: ExcelJS.Cell | null = null;
    ws.eachRow((r) => {
      const cell = r.getCell(priceCol);
      if (cell.value === row.priceAvg) priceCell = cell;
    });
    expect(priceCell).not.toBeNull();
    expect(priceCell!.numFmt).toBe("#,##0.000");
  });
});
