import { describe, expect, it } from "vitest";
import {
  approvedListBuyCheck,
  complianceApprovedListForBuys,
} from "./research-engine.js";

describe("approvedListBuyCheck", () => {
  it("allows approved_buy", () => {
    expect(approvedListBuyCheck("approved_buy").result).toBe("pass");
  });

  it("fails restricted / sell_only / hold", () => {
    expect(approvedListBuyCheck("restricted").reasonCode).toBe("APPROVED_LIST_RESTRICTED");
    expect(approvedListBuyCheck("sell_only").reasonCode).toBe("APPROVED_LIST_SELL_ONLY");
    expect(approvedListBuyCheck("hold").reasonCode).toBe("APPROVED_LIST_HOLD");
  });

  it("warns on watchlist / missing", () => {
    expect(approvedListBuyCheck("watchlist").result).toBe("warning");
    expect(approvedListBuyCheck(null).result).toBe("warning");
  });
});

describe("complianceApprovedListForBuys", () => {
  it("only checks net buys", () => {
    const checks = complianceApprovedListForBuys([
      { ticker: "QNBK", isNetBuy: true, status: "restricted" },
      { ticker: "IQCD", isNetBuy: false, status: "restricted" },
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe("fail");
  });
});
