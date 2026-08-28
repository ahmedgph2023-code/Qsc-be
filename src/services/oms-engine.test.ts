import { describe, expect, it } from "vitest";
import { allocateProRata } from "./oms-engine.js";

describe("allocateProRata", () => {
  it("splits fill across orders by quantity weight", () => {
    const out = allocateProRata(
      [
        { orderId: "a", quantity: 100 },
        { orderId: "b", quantity: 300 },
      ],
      200,
    );
    expect(out[0].allocQty).toBe(50);
    expect(out[1].allocQty).toBe(150);
  });

  it("returns zeros for empty fill", () => {
    const out = allocateProRata([{ orderId: "a", quantity: 10 }], 0);
    expect(out[0].allocQty).toBe(0);
  });
});
