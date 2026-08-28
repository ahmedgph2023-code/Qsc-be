import { describe, expect, it } from "vitest";
import { applyReplayEvents } from "./holdings-replay.js";
import { previewCashBalance, tradesToReplayEvents } from "./sheet-portfolio-preview.js";

describe("sheet-portfolio-preview", () => {
  it("replays trades with the same holdings engine Customer Details uses", () => {
    const events = tradesToReplayEvents([
      { ticker: "GISS", type: "BUY", qty: 1000, price: 3.2, date: "2024-01-15", notes: "Buy", portfolioKey: "1" },
      { ticker: "GISS", type: "SELL", qty: 200, price: 3.5, date: "2024-02-01", notes: "Sell", portfolioKey: "1" },
    ], new Map([["GISS", "sid-1"]]));
    const agg = applyReplayEvents(events);
    expect(agg.get("sid-1")?.quantity).toBe(800);
    expect(agg.get("sid-1")?.totalCost).toBeCloseTo(800 * 3.2, 6);
  });

  it("sums cash ledger as-of with the same sign rules", () => {
    const bal = previewCashBalance([
      { tradeDate: "2024-01-02", type: "deposit", amount: 500000, reference: "1", notes: "funding" },
      { tradeDate: "2024-01-04", type: "fee", amount: 250, reference: "2", notes: "fee" },
      { tradeDate: "2024-06-01", type: "deposit", amount: 10, reference: "3", notes: "later" },
    ], "2024-03-01");
    expect(bal).toBe(499750);
  });
});
