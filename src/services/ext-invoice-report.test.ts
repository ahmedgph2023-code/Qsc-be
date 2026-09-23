import {
  getInvoiceReport,
  invTypeFromOrderType,
  invoiceSideFromInvType,
  listInvoiceClients,
  mapInvoiceClientOption,
  mapInvoiceReportRow,
  normalizeOrderType,
  sumInvoiceTotals,
} from "./ext-invoice-report.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/mssql.js", () => ({
  getMssqlPool: vi.fn(),
  sql: { Date: "Date", Int: "Int", NVarChar: () => "NVarChar" },
}));

describe("invoiceSideFromInvType", () => {
  it("maps OI/OC only", () => {
    expect(invoiceSideFromInvType("OI")).toBe("Buy");
    expect(invoiceSideFromInvType("oc")).toBe("Sell");
    expect(invoiceSideFromInvType("NI")).toBeNull();
  });
});

describe("mapInvoiceReportRow", () => {
  it("keeps side and SQL commission fields", () => {
    const buy = mapInvoiceReportRow({
      InvNo: 323860,
      InvoiceSequence: 4471,
      InvType: "OI",
      ClientId: 2041933,
      Nin: "47016",
      TickerId: "DBIS",
      InvDate: "2026-09-09",
      Qty: 600000,
      AvgPrice: 1.581,
      Total: 948649.005,
      Net: 951257.79,
      TotalComm: 2608.78,
      OfficeComm: 1992.16,
      MarketComm: 616.62,
      SceLongName: "DLALA",
      NAME_EN: "Fahad",
      CL_CLIENT_TYPE: "INV PORT",
    });
    expect(buy?.orderSide).toBe("Buy");
    expect(buy?.qty).toBe(600000);
    expect(buy?.totalComm).toBe(2608.78);
    expect(buy?.market).toBe("QATAR STOCK EXCHANGE");
  });

  // Client 19 Sep 2026: the column labelled "Invoice Sequence" was showing InvNo.
  it("reads sequence from InvoiceSequence and number from InvNo", () => {
    const row = mapInvoiceReportRow({
      InvNo: 323860,
      InvoiceSequence: 4471,
      InvType: "OC",
      ClientId: 2041933,
      Qty: 100,
      InvDate: "2026-09-09",
      TickerId: "QNBK",
    });
    expect(row?.invSequence).toBe(4471);
    expect(row?.invNo).toBe(323860);
  });

  it("leaves sequence null when the feed omits it instead of falling back to InvNo", () => {
    const row = mapInvoiceReportRow({
      InvNo: 323860,
      InvType: "OI",
      ClientId: 1,
      Qty: 1,
      InvDate: "2026-09-09",
      TickerId: "QNBK",
    });
    expect(row?.invSequence).toBeNull();
    expect(row?.invNo).toBe(323860);
  });
});

describe("sumInvoiceTotals", () => {
  it("sums amount/comm/net", () => {
    const rows = [
      mapInvoiceReportRow({
        InvType: "OI", ClientId: 1, Qty: 10, Total: 100, Net: 101, TotalComm: 1,
        OfficeComm: 0.7, MarketComm: 0.3, InvDate: "2026-09-09", TickerId: "A",
      })!,
      mapInvoiceReportRow({
        InvType: "OC", ClientId: 2, Qty: 5, Total: 50, Net: 49, TotalComm: 1,
        OfficeComm: 0.7, MarketComm: 0.3, InvDate: "2026-09-09", TickerId: "B",
      })!,
    ];
    const t = sumInvoiceTotals(rows);
    expect(t.count).toBe(2);
    expect(t.amount).toBe(150);
    expect(t.qty).toBe(15);
    expect(t.net).toBe(150);
  });
});

describe("order type filter", () => {
  it("maps the three choices to InvType", () => {
    expect(invTypeFromOrderType("buy")).toBe("OI");
    expect(invTypeFromOrderType("sell")).toBe("OC");
    expect(invTypeFromOrderType("all")).toBeNull();
  });

  it("falls back to all for anything unexpected in the query string", () => {
    expect(normalizeOrderType("BUY")).toBe("buy");
    expect(normalizeOrderType(" sell ")).toBe("sell");
    expect(normalizeOrderType("both")).toBe("all");
    expect(normalizeOrderType(undefined)).toBe("all");
  });
});

describe("mapInvoiceClientOption", () => {
  it("builds a customer option with its invoice count", () => {
    const option = mapInvoiceClientOption({
      ClientId: 2041933,
      Nin: "47016",
      InvoiceCount: 12,
      NAME_EN: "FAHAD",
    });
    expect(option).toEqual({ clientId: 2041933, nin: "47016", name: "FAHAD", invoiceCount: 12 });
  });

  it("skips rows without a client id", () => {
    expect(mapInvoiceClientOption({ Nin: "47016" })).toBeNull();
  });
});

describe("getInvoiceReport wiring", () => {
  it("is exported", () => {
    expect(typeof getInvoiceReport).toBe("function");
    expect(typeof listInvoiceClients).toBe("function");
  });
});
