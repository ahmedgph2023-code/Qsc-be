import { describe, expect, it } from "vitest";
import {
  CLOUD_API_CANNOT_IMPORT,
  HISTORY_DECLINED_CODE,
  META_HISTORY_CAPABILITIES,
  flattenHistoryThreads,
  flattenStandaloneMessages,
  isMetaWebhookEnvelope,
  mapDeliveryStatus,
  messageDirection,
  parseHistoryDeclines,
  parseSmbContacts,
  parseCloudMessageContent,
  shouldEnrichExisting,
  webhookChanges,
} from "./ingest-parse.js";

const HISTORY_EXAMPLE = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550783881",
              phone_number_id: "106540352242922",
            },
            history: [
              {
                metadata: { phase: 0, chunk_order: 1, progress: 55 },
                threads: [
                  {
                    id: "16505551234",
                    messages: [
                      {
                        from: "15550783881",
                        id: "wamid.OUTBOUND_TEXT",
                        timestamp: "1739230955",
                        type: "text",
                        text: { body: "Here's the info you requested!" },
                        history_context: { status: "READ" },
                      },
                      {
                        from: "15550783881",
                        id: "wamid.PLACEHOLDER",
                        timestamp: "1739230970",
                        type: "media_placeholder",
                        history_context: { status: "PLAYED" },
                      },
                      {
                        from: "16505551234",
                        id: "wamid.INBOUND_TEXT",
                        timestamp: "1739230970",
                        type: "text",
                        text: { body: "Thanks!" },
                        history_context: { status: "READ" },
                      },
                    ],
                  },
                  {
                    id: "12125557890",
                    messages: [
                      {
                        from: "15550783881",
                        id: "wamid.THANKS30",
                        timestamp: "1739230970",
                        type: "text",
                        text: { body: "Thanks for your order!" },
                        history_context: { status: "DELIVERED" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          field: "history",
        },
      ],
    },
  ],
};

describe("WhatsApp Meta history ingest (parse)", () => {
  it("does not claim Graph can list conversations or GET message history", () => {
    expect(META_HISTORY_CAPABILITIES.graphHasConversationList).toBe(false);
    expect(META_HISTORY_CAPABILITIES.graphHasMessageHistoryGet).toBe(false);
    expect(CLOUD_API_CANNOT_IMPORT.some((row) => row.key === "chat_history_via_graph")).toBe(true);
  });

  it("flattens official history threads with inbound/outbound from `from` vs thread id", () => {
    const change = webhookChanges(HISTORY_EXAMPLE)[0];
    expect(change.field).toBe("history");
    const rows = flattenHistoryThreads(
      change.value.history as unknown[],
      "15550783881",
    );
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.wamid)).size).toBe(4);
    expect(rows.find((r) => r.wamid === "wamid.OUTBOUND_TEXT")).toMatchObject({
      waId: "16505551234",
      direction: "outbound",
      status: "read",
    });
    expect(rows.find((r) => r.wamid === "wamid.INBOUND_TEXT")).toMatchObject({
      waId: "16505551234",
      direction: "inbound",
    });
    expect(rows.find((r) => r.wamid === "wamid.PLACEHOLDER")?.parsed.type).toBe("media_placeholder");
    expect(rows.find((r) => r.wamid === "wamid.PLACEHOLDER")?.parsed.mediaId).toBeNull();
  });

  it("enriches a media_placeholder when the follow-up history webhook carries the same wamid", () => {
    const placeholder = parseCloudMessageContent({ type: "media_placeholder" });
    const image = parseCloudMessageContent({
      type: "image",
      image: { id: "24230790383178626", mime_type: "image/jpeg", caption: "Black Prince echeveria" },
    });
    expect(shouldEnrichExisting({ mediaId: null, messageType: "media_placeholder" }, image)).toBe(true);
    expect(shouldEnrichExisting({ mediaId: "24230790383178626", messageType: "image" }, placeholder)).toBe(
      false,
    );
  });

  it("maps history_context and PLAYED without inventing bodies", () => {
    expect(mapDeliveryStatus("PLAYED")).toBe("delivered");
    expect(mapDeliveryStatus("READ")).toBe("read");
    expect(parseCloudMessageContent({ type: "media_placeholder" }).body).toBeNull();
  });

  it("records declined history as error 2593109 and does not invent threads", () => {
    const declines = parseHistoryDeclines([
      {
        errors: [
          {
            code: Number(HISTORY_DECLINED_CODE),
            title: "History sync is turned off by the business from the WhatsApp Business App",
            message: "History sync is turned off by the business from the WhatsApp Business App",
          },
        ],
      },
    ]);
    expect(declines[0].code).toBe(HISTORY_DECLINED_CODE);
    expect(flattenHistoryThreads([{ errors: declines }])).toEqual([]);
  });

  it("accepts only Meta webhook envelopes for dump import", () => {
    expect(isMetaWebhookEnvelope(HISTORY_EXAMPLE)).toBe(true);
    expect(isMetaWebhookEnvelope({ contacts: [{ phone: "97433112233" }] })).toBe(false);
    expect(isMetaWebhookEnvelope({ rows: [] })).toBe(false);
  });

  it("parses smb_app_state_sync contacts without creating messages", () => {
    const contacts = parseSmbContacts([
      {
        type: "contact",
        action: "add",
        contact: { full_name: "Ahmed", phone_number: "97433112233" },
      },
    ]);
    expect(contacts).toEqual([{ waId: "97433112233", displayName: "Ahmed", action: "add" }]);
  });

  it("treats smb echoes as outbound to the recipient", () => {
    const rows = flattenStandaloneMessages(
      [
        {
          from: "15550783881",
          to: "16505551234",
          id: "wamid.ECHO",
          timestamp: "1739230955",
          type: "text",
          text: { body: "Sent from the Business app" },
        },
      ],
      { businessDisplayNumber: "15550783881", forcedDirection: "outbound" },
    );
    expect(rows[0]).toMatchObject({ waId: "16505551234", direction: "outbound", wamid: "wamid.ECHO" });
  });

  it("classifies direction from business display vs user thread", () => {
    expect(
      messageDirection({
        from: "15550783881",
        threadId: "16505551234",
        businessDisplayNumber: "15550783881",
      }),
    ).toBe("outbound");
    expect(
      messageDirection({
        from: "16505551234",
        threadId: "16505551234",
        businessDisplayNumber: "15550783881",
      }),
    ).toBe("inbound");
  });
});
