import { getInvoiceReport, invoiceSideFromInvType, sumInvoiceTotals, mapInvoiceReportRow } from "./ext-invoice-report.js";
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
  it("splits buy/sell qty and keeps SQL commission fields", () => {
    const buy = mapInvoiceReportRow({
      InvNo: 323860,
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
    expect(buy?.buyQty).toBe(600000);
    expect(buy?.sellQty).toBe(0);
    expect(buy?.totalComm).toBe(2608.78);
    expect(buy?.market).toBe("QATAR STOCK EXCHANGE");
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
    expect(t.buyQty).toBe(10);
    expect(t.sellQty).toBe(5);
  });
});

describe("getInvoiceReport wiring", () => {
  it("is exported", () => {
    expect(typeof getInvoiceReport).toBe("function");
  });
});
