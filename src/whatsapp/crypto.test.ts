import { describe, expect, it } from "vitest";
import { normalizeWaId } from "./crypto.js";

describe("normalizeWaId (Qatar)", () => {
  it("keeps +974 E.164 digits", () => {
    expect(normalizeWaId("+974 3311 2233")).toBe("97433112233");
    expect(normalizeWaId("97433112233")).toBe("97433112233");
    expect(normalizeWaId("0097433112233")).toBe("97433112233");
  });

  it("prefixes 8-digit Qatar national numbers with 974", () => {
    expect(normalizeWaId("33112233")).toBe("97433112233");
    expect(normalizeWaId("55114455")).toBe("97455114455");
    expect(normalizeWaId("44123456")).toBe("97444123456");
  });

  it("does not treat Egyptian local 01… as +20", () => {
    expect(normalizeWaId("01012345678")).toBeNull();
    expect(normalizeWaId("+20 10 1234 5678")).toBe("201012345678");
  });
});
