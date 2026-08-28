import { describe, expect, it } from "vitest";
import { isCashTransferRow, isClientTransferRow, isInKindShareMove, isSell, parseStockTxType, qtyDelta } from "../lib/tx-type.js";

describe("tx-type — BUY/CLIENT_TRANSFER increase qty; SELL decreases", () => {
  it("treats only SELL as a sell", () => {
    expect(isSell("SELL")).toBe(true);
    expect(isSell("BUY")).toBe(false);
    expect(isSell("CLIENT_TRANSFER")).toBe(false);
  });

  it("qtyDelta signs quantity by side", () => {
    expect(qtyDelta("BUY", 10)).toBe(10);
    expect(qtyDelta("CLIENT_TRANSFER", 10)).toBe(10);
    expect(qtyDelta("SELL", 10)).toBe(-10);
  });

  it("parseStockTxType maps transfer-out to SELL not BUY", () => {
    expect(parseStockTxType("TRANSFER_IN")).toBe("CLIENT_TRANSFER");
    expect(parseStockTxType("equity transfer-out")).toBe("SELL");
    expect(parseStockTxType("EQUITY_TRANSFER_OUT")).toBe("SELL");
    expect(parseStockTxType("sell")).toBe("SELL");
    expect(parseStockTxType("BUY")).toBe("BUY");
  });

  it("treats equity transfer notes as in-kind", () => {
    expect(isInKindShareMove("CLIENT_TRANSFER", null)).toBe(true);
    expect(isInKindShareMove("SELL", "Invoice 1; Equity Transfer-Out")).toBe(true);
    expect(isInKindShareMove("SELL", "plain sale")).toBe(false);
  });

  it("distinguishes in-kind transfer from cash TRANSFER/WITHDRAWAL rows", () => {
    expect(isClientTransferRow("CLIENT_TRANSFER")).toBe(true);
    expect(isCashTransferRow("WITHDRAWAL")).toBe(true);
    expect(isClientTransferRow("WITHDRAWAL")).toBe(false);
  });
});
