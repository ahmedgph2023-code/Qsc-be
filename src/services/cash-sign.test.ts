import { describe, expect, it } from "vitest";
import { CASH_DEBIT_TYPES, signedCashDelta, sumCashLedgerAsOf } from "./cash-sign.js";

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

describe("signedCashDelta — cash ledger stores abs amount; type sets sign", () => {
  it("debits withdrawal, fee, and trade_buy (cash-sign.ts contract)", () => {
    expect([...CASH_DEBIT_TYPES].sort()).toEqual(["fee", "trade_buy", "withdrawal"].sort());
    expect(signedCashDelta("withdrawal", 100)).toBe(-100);
    expect(signedCashDelta("fee", 50.25)).toBe(-50.25);
    expect(signedCashDelta("trade_buy", 10)).toBe(-10);
  });

  it("credits deposit, dividend, trade_sell, and commission_rebate", () => {
    expect(signedCashDelta("deposit", 200)).toBe(200);
    expect(signedCashDelta("dividend", 750)).toBe(750);
    expect(signedCashDelta("trade_sell", 10)).toBe(10);
    expect(signedCashDelta("commission_rebate", 5)).toBe(5);
  });

  it("uses absolute amount even if a negative number is passed", () => {
    expect(signedCashDelta("fee", -80)).toBe(-80);
    expect(signedCashDelta("deposit", -80)).toBe(80);
  });
});

describe("sumCashLedgerAsOf — Cash(D) = Σ signed rows with tradeDate <= asOf (HP-W2)", () => {
  /** Amounts follow Excel §4.2 so the *sum/clip* contract can be locked. Live `trade_buy` posting is qty×price (see WAVE-2-CHARACTERIZATION.md). */
  const ledger = [
    { type: "deposit", amount: 3_000_000, tradeDate: "2024-07-01" },
    { type: "trade_buy", amount: 1_530, tradeDate: "2024-07-02" },
    { type: "trade_buy", amount: 2_998_459.35, tradeDate: "2024-07-02" },
    { type: "trade_sell", amount: 1_981.4, tradeDate: "2024-07-03" },
    { type: "fee", amount: 50, tradeDate: "2024-07-10" },
  ];

  it("includes opening credit on as-of date (requirements §4.2 01/07/2024)", () => {
    expect(sumCashLedgerAsOf(ledger, "2024-07-01")).toBe(3_000_000);
  });

  it("credits minus same-day buy debits (requirements §4.2 after two MHAR buys)", () => {
    expect(sumCashLedgerAsOf(ledger, "2024-07-02")).toBe(10.65);
  });

  it("adds sell credit and still excludes later fee until that date", () => {
    expect(sumCashLedgerAsOf(ledger, "2024-07-03")).toBe(round4(10.65 + 1_981.4));
    expect(sumCashLedgerAsOf(ledger, "2024-07-09")).toBe(round4(10.65 + 1_981.4));
    expect(sumCashLedgerAsOf(ledger, "2024-07-10")).toBe(round4(10.65 + 1_981.4 - 50));
  });

  it("rounds to 4 dp like getCashBalanceAsOf", () => {
    expect(sumCashLedgerAsOf([{ type: "deposit", amount: 1 / 3, tradeDate: "2024-01-01" }], "2024-01-01")).toBe(0.3333);
  });
});
