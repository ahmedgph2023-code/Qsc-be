import { describe, expect, it } from "vitest";
import { estimateMessageCostUsd } from "./usage.js";
import { categorizeMessage, marketFromWaId, rateFor, USD_TO_QAR } from "./pricing.js";

describe("WhatsApp usage estimates", () => {
  it("maps Qatar waId to QATAR market", () => {
    expect(marketFromWaId("97433112233")).toBe("QATAR");
    expect(marketFromWaId("971501234567")).toBe("UAE");
  });

  it("treats free-form service messages as zero cost", () => {
    expect(
      estimateMessageCostUsd({
        direction: "outbound",
        status: "delivered",
        messageType: "text",
        waId: "97433112233",
      }),
    ).toBe(0);
  });

  it("estimates utility template cost using the Qatar rate card", () => {
    const cost = estimateMessageCostUsd({
      direction: "outbound",
      status: "delivered",
      messageType: "template",
      pricingCategory: "UTILITY",
      waId: "97433112233",
    });
    expect(cost).toBe(rateFor("QATAR", "UTILITY").rate);
    expect(Number((cost * USD_TO_QAR).toFixed(2))).toBeGreaterThan(0);
  });

  it("does not bill inbound or failed messages", () => {
    expect(
      estimateMessageCostUsd({
        direction: "inbound",
        status: "received",
        messageType: "template",
        waId: "97433112233",
      }),
    ).toBe(0);
    expect(
      estimateMessageCostUsd({
        direction: "outbound",
        status: "failed",
        messageType: "template",
        waId: "97433112233",
      }),
    ).toBe(0);
  });

  it("categorizes templates as utility unless Meta pricing is stored", () => {
    expect(categorizeMessage({ messageType: "template" })).toBe("UTILITY");
    expect(categorizeMessage({ messageType: "template", pricingCategory: "MARKETING" })).toBe(
      "MARKETING",
    );
  });
});
