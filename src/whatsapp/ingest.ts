import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappConversations, whatsappMessages } from "../db/schema/whatsapp.js";
import { findOrCreateByWaId, touchConversation, syncLastInboundAtById } from "./conversations.js";
import { logWhatsAppActivity } from "./activity.js";
import {
  flattenHistoryThreads,
  flattenStandaloneMessages,
  parseHistoryDeclines,
  parseHistoryChunks,
  parseSmbContacts,
  shouldEnrichExisting,
  webhookChanges,
  type FlattenedHistoryMessage,
} from "./ingest-parse.js";

export type IngestStats = {
  inserted: number;
  updated: number;
  skipped: number;
  contacts: number;
  declines: number;
};

function emptyStats(): IngestStats {
  return { inserted: 0, updated: 0, skipped: 0, contacts: 0, declines: 0 };
}

function addStats(a: IngestStats, b: IngestStats): IngestStats {
  return {
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    contacts: a.contacts + b.contacts,
    declines: a.declines + b.declines,
  };
}

export async function ingestWebhookPayload(
  configId: string,
  payload: unknown,
  opts?: { bumpUnread?: boolean },
): Promise<IngestStats> {
  let stats = emptyStats();
  const bumpUnread = opts?.bumpUnread === true;
  for (const change of webhookChanges(payload)) {
    stats = addStats(await ingestWebhookChange(configId, change.field, change.value, { bumpUnread }), stats);
  }
  return stats;
}

export async function ingestWebhookChange(
  configId: string,
  field: string,
  value: Record<string, unknown>,
  opts?: { bumpUnread?: boolean },
): Promise<IngestStats> {
  const businessDisplay = String(
    (value.metadata as { display_phone_number?: string } | undefined)?.display_phone_number || "",
  );
  const stats = emptyStats();

  if (field === "history") {
    const history = value.history as unknown[] | undefined;
    const declines = parseHistoryDeclines(history);
    if (declines.length) {
      stats.declines += declines.length;
      await logWhatsAppActivity(
        "webhook.history_declined",
        null,
        { errors: declines },
        configId,
      );
    }
    const chunks = parseHistoryChunks(history);
    if (chunks.length) {
      await logWhatsAppActivity("webhook.history_chunk", null, { chunks }, configId);
    }
    const fromThreads = flattenHistoryThreads(history, businessDisplay, value.contacts as unknown[]);
    const fromMessages = flattenStandaloneMessages(value.messages as unknown[] | undefined, {
      businessDisplayNumber: businessDisplay,
      contacts: value.contacts as unknown[],
    });
    const merged = mergeByWamid(fromThreads, fromMessages);
    const msgStats = await ingestFlattenedMessages(configId, merged, { bumpUnread: false });
    return addStats(stats, msgStats);
  }

  if (field === "smb_app_state_sync") {
    const contacts = parseSmbContacts(value.state_sync as unknown[] | undefined);
    for (const contact of contacts) {
      if (contact.action === "remove") continue;
      await findOrCreateByWaId({
        configId,
        waId: contact.waId,
        displayName: contact.displayName || contact.waId,
      });
      stats.contacts += 1;
    }
    if (stats.contacts > 0) {
      await logWhatsAppActivity("webhook.contacts_synced", null, { count: stats.contacts }, configId);
    }
    return stats;
  }

  if (field === "message_template_status_update") {
    await logWhatsAppActivity(
      "webhook.template_status",
      null,
      {
        event: value.event || null,
        messageTemplateId: value.message_template_id || null,
        messageTemplateName: value.message_template_name || null,
        messageTemplateLanguage: value.message_template_language || null,
      },
      configId,
    );
    return stats;
  }

  if (field === "smb_message_echoes") {
    await processStatuses(value.statuses as unknown[] | undefined);
    const rows = flattenStandaloneMessages(value.messages as unknown[] | undefined, {
      businessDisplayNumber: businessDisplay,
      contacts: value.contacts as unknown[],
      forcedDirection: "outbound",
    });
    return ingestFlattenedMessages(configId, rows, { bumpUnread: false });
  }

  if (field !== "messages") {
    return stats;
  }

  const statusCount = await processStatuses(value.statuses as unknown[] | undefined);
  stats.updated += statusCount;
  const rows = flattenStandaloneMessages(value.messages as unknown[] | undefined, {
    businessDisplayNumber: businessDisplay,
    contacts: value.contacts as unknown[],
    forcedDirection: "inbound",
  });
  return addStats(stats, await ingestFlattenedMessages(configId, rows, { bumpUnread: opts?.bumpUnread !== false }));
}

function mergeByWamid(...lists: FlattenedHistoryMessage[][]): FlattenedHistoryMessage[] {
  const map = new Map<string, FlattenedHistoryMessage>();
  for (const list of lists) {
    for (const row of list) {
      const prev = map.get(row.wamid);
      if (!prev) {
        map.set(row.wamid, row);
        continue;
      }
      if (shouldEnrichExisting({ mediaId: prev.parsed.mediaId, messageType: prev.parsed.type }, row.parsed)) {
        map.set(row.wamid, { ...prev, parsed: row.parsed, raw: row.raw, timestamp: row.timestamp });
      }
    }
  }
  return [...map.values()];
}

async function ingestFlattenedMessages(
  configId: string,
  rows: FlattenedHistoryMessage[],
  opts: { bumpUnread: boolean },
): Promise<IngestStats> {
  const stats = emptyStats();
  for (const row of rows) {
    const result = await upsertMessage(configId, row, opts);
    stats[result] += 1;
  }
  if (stats.inserted > 0) {
    await logWhatsAppActivity(
      "webhook.messages_received",
      null,
      { count: stats.inserted, updated: stats.updated, skipped: stats.skipped },
      configId,
    );
  }
  return stats;
}

async function upsertMessage(
  configId: string,
  row: FlattenedHistoryMessage,
  opts: { bumpUnread: boolean },
): Promise<"inserted" | "updated" | "skipped"> {
  const [existing] = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.wamid, row.wamid))
    .limit(1);

  if (existing) {
    const incoming = row.parsed;
    if (shouldEnrichExisting(existing, incoming)) {
      await db
        .update(whatsappMessages)
        .set({
          messageType: incoming.type,
          body: incoming.body ?? existing.body,
          mediaId: incoming.mediaId || existing.mediaId,
          mediaMimeType: incoming.mimeType || existing.mediaMimeType,
          mediaFileName: incoming.fileName || existing.mediaFileName,
          status: row.status || existing.status,
          rawPayload: row.raw,
          providerTimestamp: row.timestamp,
          updatedAt: new Date(),
        })
        .where(eq(whatsappMessages.id, existing.id));
      return "updated";
    }
    if (existing.direction === "inbound" && existing.conversationId) {
      await syncLastInboundAtById(existing.conversationId);
    }
    return "skipped";
  }

  const conversation = await findOrCreateByWaId({
    configId,
    waId: row.waId,
    displayName: row.displayName,
  });

  try {
    await db.insert(whatsappMessages).values({
      conversationId: conversation.id,
      direction: row.direction,
      messageType: row.parsed.type,
      body: row.parsed.body,
      wamid: row.wamid,
      status: row.direction === "inbound" && row.status === "received" ? "received" : row.status,
      mediaId: row.parsed.mediaId,
      mediaMimeType: row.parsed.mimeType,
      mediaFileName: row.parsed.fileName,
      rawPayload: row.raw,
      providerTimestamp: row.timestamp,
      createdAt: row.timestamp,
      updatedAt: row.timestamp,
    });
  } catch {
    return "skipped";
  }

  await touchConversation(conversation, row.parsed.preview, {
    inbound: row.direction === "inbound",
    bumpUnread: opts.bumpUnread && row.direction === "inbound",
    at: row.timestamp,
  });
  return "inserted";
}

async function processStatuses(statuses: unknown[] | undefined) {
  if (!Array.isArray(statuses) || statuses.length === 0) return 0;
  let count = 0;
  for (const status of statuses) {
    const s = status as Record<string, unknown>;
    const wamid = s?.id as string | undefined;
    if (!wamid) continue;
    const [message] = await db
      .select()
      .from(whatsappMessages)
      .where(eq(whatsappMessages.wamid, wamid))
      .limit(1);
    if (!message) continue;
    const mapped = String(s.status || "").toLowerCase();
    const updates: Partial<typeof whatsappMessages.$inferInsert> = {
      updatedAt: new Date(),
      rawPayload: { ...(message.rawPayload as object), status: s },
    };
    if (["sent", "delivered", "read", "failed"].includes(mapped)) updates.status = mapped;
    const errors = s.errors as Array<Record<string, unknown>> | undefined;
    if (errors?.[0]) {
      updates.errorCode = String(errors[0].code || "");
      updates.errorMessage = String(errors[0].title || errors[0].message || "");
      updates.status = "failed";
    }
    const pricing = s.pricing as Record<string, unknown> | undefined;
    if (pricing) {
      updates.pricingCategory = String(pricing.category || pricing.pricing_category || "") || null;
      updates.pricingType = String(pricing.type || pricing.pricing_type || "") || null;
      updates.pricingModel = String(pricing.pricing_model || pricing.model || "") || null;
      if (typeof pricing.billable === "boolean") updates.billable = pricing.billable;
    }
    await db.update(whatsappMessages).set(updates).where(eq(whatsappMessages.id, message.id));
    count += 1;
  }
  return count;
}

export async function localInboxCounts(configId: string) {
  const [{ conversations }] = await db
    .select({ conversations: sql<number>`count(*)::int` })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.configId, configId));
  const [{ messages }] = await db
    .select({ messages: sql<number>`count(*)::int` })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .where(eq(whatsappConversations.configId, configId));
  return {
    conversations: Number(conversations) || 0,
    messages: Number(messages) || 0,
  };
}
