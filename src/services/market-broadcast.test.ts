import { describe, expect, it } from "vitest";
import { getBroadcastStatus, isBroadcastUrlConfigured } from "./market-broadcast.js";

describe("market broadcast status", () => {
  it("stays disconnected without a URL and never ingests official closes", () => {
    const status = getBroadcastStatus({});
    expect(isBroadcastUrlConfigured({})).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.ingestOfficialCloses).toBe(false);
    expect(status.valuationSource).toBe("official_close");
    expect(status.blockedReason).toBe("NO_BROADCAST_WS_URL");
  });

  it("still refuses to connect when a URL is set without JSON samples", () => {
    const status = getBroadcastStatus({ BROADCAST_WS_URL: "wss://example.invalid/feed" });
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.ingestOfficialCloses).toBe(false);
    expect(status.blockedReason).toBe("NO_JSON_SAMPLE");
  });
});
