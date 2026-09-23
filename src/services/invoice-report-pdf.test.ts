/** Invoice Report PDF — brand header, selected filters, and a real PDF buffer. */
import { describe, expect, it } from "vitest";
import {
  INVOICE_PDF_PRINTABLE_WIDTH,
  INVOICE_PDF_TABLE_WIDTH,
  invoiceReportPdf,
} from "./invoice-report-pdf.js";
import { invoiceFilterHeaderLines, type InvoiceReportResult } from "./ext-invoice-report.js";

const report: InvoiceReportResult = {
  title: "Customer Invoices",
  from: "2026-09-01",
  to: "2026-09-15",
  filters: { clientId: 2041933, clientName: "FAHAD", ticker: "QNBK", orderType: "sell", invNo: null },
  rows: [
    {
      invSequence: 4471,
      invNo: 323860,
      orderSide: "Sell",
      invType: "OC",
      accountId: 2041933,
      nin: "47016",
      accountName: "FAHAD",
      ticker: "QNBK",
      company: "QNB",
      market: "QATAR STOCK EXCHANGE",
      tradeDate: "2026-09-09",
      qty: 1000,
      priceAvg: 16.125,
      amount: 16125,
      totalComm: 43.5,
      officeComm: 33.2,
      marketComm: 10.3,
      net: 16081.5,
    },
  ],
  totals: {
    amount: 16125,
    totalComm: 43.5,
    officeComm: 33.2,
    marketComm: 10.3,
    net: 16081.5,
    qty: 1000,
    count: 1,
  },
};

describe("invoiceFilterHeaderLines", () => {
  it("labels every filter, using All when unset", () => {
    const lines = invoiceFilterHeaderLines({
      ...report,
      filters: { clientId: null, clientName: null, ticker: null, orderType: "all", invNo: null },
    });
    expect(lines.map((l) => `${l.label}: ${l.value}`)).toEqual([
      "Period: 01/09/2026 – 15/09/2026",
      "Customer: All Customers",
      "Stock: All Stocks",
      "Order Type: All",
      "Invoice: All Invoices",
    ]);
  });

  it("shows the chosen customer, stock, side and invoice", () => {
    const values = Object.fromEntries(invoiceFilterHeaderLines(report).map((l) => [l.label, l.value]));
    expect(values.Customer).toBe("FAHAD (2041933)");
    expect(values.Stock).toBe("QNBK");
    expect(values["Order Type"]).toBe("Sell");
  });
});

describe("invoiceReportPdf", () => {
  // The first draft overflowed the page and silently dropped Market Comm. and Net.
  it("keeps every column inside the printable width", () => {
    expect(INVOICE_PDF_TABLE_WIDTH).toBeLessThanOrEqual(INVOICE_PDF_PRINTABLE_WIDTH);
  });

  it("produces a PDF named for the period", async () => {
    const { filename, buffer } = await invoiceReportPdf(report);
    expect(filename).toBe("CustomerInvoices_2026-09-01_2026-09-15.pdf");
    expect(buffer.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });
});
