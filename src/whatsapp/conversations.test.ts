import { describe, expect, it } from "vitest";
import { isRepliedConversation, isUnrepliedConversation } from "./conversation-filters.js";

describe("WhatsApp conversation filters", () => {
  it("marks a chat unreplied when inbound is the latest event", () => {
    expect(
      isUnrepliedConversation({
        lastInboundAt: "2026-09-02T12:00:00.000Z",
        lastMessageAt: "2026-09-02T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isRepliedConversation({
        lastInboundAt: "2026-09-02T12:00:00.000Z",
        lastMessageAt: "2026-09-02T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("marks a chat replied when outbound is later than inbound", () => {
    expect(
      isRepliedConversation({
        lastInboundAt: "2026-09-02T10:00:00.000Z",
        lastMessageAt: "2026-09-02T11:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isUnrepliedConversation({
        lastInboundAt: "2026-09-02T10:00:00.000Z",
        lastMessageAt: "2026-09-02T11:00:00.000Z",
      }),
    ).toBe(false);
  });
});
