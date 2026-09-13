import { describe, expect, it } from "vitest";
import {
  mapClientCurrentOrder,
  mapOrderStatus,
  mapOrderType,
  mapOrderValidity,
} from "./ext-client-orders.js";

describe("client order mappers", () => {
  it("maps buy/sell and status labels", () => {
    expect(mapOrderType("B")).toBe("Buy");
    expect(mapOrderType("S")).toBe("Sell");
    expect(mapOrderStatus("P").statusLabel).toBe("Partially Executed");
    expect(mapOrderStatus("A").statusLabel).toBe("Active");
  });

  it("maps Daily vs Date validity", () => {
    expect(mapOrderValidity({ Validity: "Daily" }, ["Validity"])).toEqual({ kind: "Daily" });
    expect(mapOrderValidity({ Validity: "Date", ValidUntil: "2026-09-20" }, ["Validity", "ValidUntil"])).toEqual({
      kind: "Date",
      until: "2026-09-20",
    });
  });

  it("maps a typical row with flexible columns", () => {
    const columns = ["OrderNo", "BuySellFlag", "ClientId", "TickerId", "Status", "Qty", "RemainingQty", "ExecutedQty", "OrderDate"];
    const row = mapClientCurrentOrder(
      {
        OrderNo: 99,
        BuySellFlag: "B",
        ClientId: 2041933,
        TickerId: "QNBK",
        Status: "A",
        Qty: 1000,
        RemainingQty: 400,
        ExecutedQty: 600,
        OrderDate: "2026-09-13",
        NAME_EN: "Test",
      },
      columns,
    );
    expect(row.orderType).toBe("Buy");
    expect(row.statusLabel).toBe("Active");
    expect(row.remainingQty).toBe(400);
    expect(row.executedQty).toBe(600);
  });
});
