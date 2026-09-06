import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappConversations, whatsappMessages } from "../db/schema/whatsapp.js";
import {
  normalizeWaId,
  isWithinCustomerCareWindow,
  CUSTOMER_CARE_WINDOW_MS,
} from "./crypto.js";
import { HttpError } from "./errors.js";
import { getConfigRow } from "./config.js";
import { isRepliedConversation, isUnrepliedConversation } from "./conversation-filters.js";

type ConversationRow = typeof whatsappConversations.$inferSelect;
type MessageRow = typeof whatsappMessages.$inferSelect;

export function serializeMessage(m: MessageRow) {
  let mediaId = m.mediaId;
  let mediaMimeType = m.mediaMimeType;
  const raw = m.rawPayload as Record<string, unknown> | null;
  if (!mediaId && raw && typeof raw === "object") {
    const bucket =
      (raw.sticker || raw.image || raw.video || raw.audio || raw.document) as
        | { id?: string; mime_type?: string }
        | undefined;
    if (bucket?.id) {
      mediaId = String(bucket.id);
      mediaMimeType = bucket.mime_type || mediaMimeType;
    }
  }
  const hasMedia = Boolean(mediaId || m.mediaUrl);
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    messageType: m.messageType,
    body: m.body,
    templateName: m.templateName,
    templateLanguage: m.templateLanguage,
    templateComponents: m.templateComponents,
    wamid: m.wamid,
    status: m.status,
    errorCode: m.errorCode,
    errorMessage: m.errorMessage,
    mediaId: mediaId || null,
    mediaMimeType: mediaMimeType || null,
    mediaFileName: m.mediaFileName,
    mediaUrl: hasMedia ? `/api/whatsapp/messages/${m.id}/media` : null,
    hasMedia,
    sentBy: m.sentBy,
    providerTimestamp: m.providerTimestamp,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

async function toConversationDto(c: ConversationRow) {
  const care = await resolveCustomerCareWindow(c.id, c);
  return {
    id: c.id,
    configId: c.configId,
    waId: c.waId,
    displayName: c.displayName,
    businessName: c.businessName,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageAt: c.lastMessageAt,
    lastInboundAt: c.lastInboundAt,
    unreadCount: c.unreadCount,
    isFavorite: c.isFavorite,
    withinCustomerCareWindow: care.withinWindow,
    customerCareExpiresAt: care.expiresAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function resolveCustomerCareWindow(
  conversationId: string,
  conversation?: ConversationRow,
) {
  const c =
    conversation ||
    (await db
      .select()
      .from(whatsappConversations)
      .where(eq(whatsappConversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]));
  const withinWindow = isWithinCustomerCareWindow(c?.lastInboundAt);
  const lastInboundMs = c?.lastInboundAt ? new Date(c.lastInboundAt).getTime() : 0;
  const expiresAt =
    lastInboundMs > 0 ? new Date(lastInboundMs + CUSTOMER_CARE_WINDOW_MS) : null;
  return { withinWindow, expiresAt, lastInboundAt: c?.lastInboundAt || null };
}

async function outboundConversationIds(configId: string) {
  const rows = await db
    .selectDistinct({ id: whatsappMessages.conversationId })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .where(and(eq(whatsappConversations.configId, configId), eq(whatsappMessages.direction, "outbound")));
  return new Set(rows.map((r) => r.id));
}

export async function listConversations(
  configId: string,
  q?: string,
  limit = 50,
  filter?: string,
) {
  await getConfigRow(configId);
  const normalizedFilter = String(filter || "all").trim().toLowerCase();
  const maxLimit = ["replied", "window24h", "unreplied", "leads"].includes(normalizedFilter) ? 5000 : 500;
  const take = Math.min(Math.max(Number(limit) || 50, 1), maxLimit);

  const rows = await db
    .select()
    .from(whatsappConversations)
    .where(eq(whatsappConversations.configId, configId))
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(take);

  let filtered = rows;

  if (q?.trim()) {
    const term = q.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    filtered = filtered.filter(
      (c) =>
        (c.displayName || "").toLowerCase().includes(term) ||
        (c.businessName || "").toLowerCase().includes(term) ||
        c.waId.includes(digits),
    );
  }

  if (normalizedFilter === "unread") {
    filtered = filtered.filter((c) => (c.unreadCount || 0) > 0);
  } else if (normalizedFilter === "fav") {
    filtered = filtered.filter((c) => c.isFavorite);
  } else if (normalizedFilter === "window24h") {
    filtered = filtered.filter((c) => isWithinCustomerCareWindow(c.lastInboundAt));
  } else if (normalizedFilter === "unreplied") {
    filtered = filtered.filter((c) => isUnrepliedConversation(c));
  } else if (normalizedFilter === "replied") {
    filtered = filtered.filter((c) => isRepliedConversation(c));
  } else if (normalizedFilter === "leads") {
    const outbound = await outboundConversationIds(configId);
    filtered = filtered.filter((c) => !outbound.has(c.id));
  }

  const dtos = await Promise.all(filtered.map((c) => toConversationDto(c)));
  return dtos;
}

export async function conversationFilterCounts(configId: string) {
  await getConfigRow(configId);
  const rows = await db
    .select()
    .from(whatsappConversations)
    .where(eq(whatsappConversations.configId, configId));

  const unread = rows.filter((c) => (c.unreadCount || 0) > 0).length;
  const unreadMessages = rows.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  const fav = rows.filter((c) => c.isFavorite).length;
  const window24h = rows.filter((c) => isWithinCustomerCareWindow(c.lastInboundAt)).length;
  const unreplied = rows.filter((c) => isUnrepliedConversation(c)).length;
  const replied = rows.filter((c) => isRepliedConversation(c)).length;
  const outbound = await outboundConversationIds(configId);
  const leads = rows.filter((c) => !outbound.has(c.id)).length;

  return {
    all: rows.length,
    unread,
    unreadMessages,
    leads,
    fav,
    replied,
    window24h,
    unreplied,
  };
}

export async function getConversation(configId: string, conversationId: string) {
  const [c] = await db
    .select()
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.id, conversationId),
        eq(whatsappConversations.configId, configId),
      ),
    )
    .limit(1);
  if (!c) throw new HttpError(404, "Conversation not found");
  return toConversationDto(c);
}

export async function listMessages(
  configId: string,
  conversationId: string,
  limit = 50,
  before?: string,
) {
  await getConversation(configId, conversationId);
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(desc(sql`coalesce(${whatsappMessages.providerTimestamp}, ${whatsappMessages.createdAt})`))
    .limit(take);
  return rows.reverse().map(serializeMessage);
}

export async function markConversationRead(configId: string, conversationId: string) {
  const [c] = await db
    .select()
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.id, conversationId),
        eq(whatsappConversations.configId, configId),
      ),
    )
    .limit(1);
  if (!c) throw new HttpError(404, "Conversation not found");
  const [updated] = await db
    .update(whatsappConversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(eq(whatsappConversations.id, conversationId))
    .returning();
  return toConversationDto(updated);
}

export async function setConversationFavorite(
  configId: string,
  conversationId: string,
  isFavorite: boolean,
) {
  const [updated] = await db
    .update(whatsappConversations)
    .set({ isFavorite: Boolean(isFavorite), updatedAt: new Date() })
    .where(
      and(
        eq(whatsappConversations.id, conversationId),
        eq(whatsappConversations.configId, configId),
      ),
    )
    .returning();
  if (!updated) throw new HttpError(404, "Conversation not found");
  return toConversationDto(updated);
}

export async function openPhoneConversation(
  configId: string,
  phone: string,
  displayName?: string,
) {
  const waId = normalizeWaId(phone);
  if (!waId) {
    throw new HttpError(
      400,
      "Invalid phone number. Use country code, e.g. 974xxxxxxxx or +974 xxxx xxxx",
    );
  }
  const conversation = await findOrCreateByWaId({
    configId,
    waId,
    displayName: displayName || waId,
  });
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversation.id));
  return {
    ...(await toConversationDto(conversation)),
    messageCount: Number(count) || 0,
    syncedFromDb: true,
    metaHistoryNote:
      "Meta Cloud API has no GET for past chats. History appears only from a Meta history webhook (WhatsApp Business app onboard with consent, last 180 days) or a Meta webhook JSON dump. Chats that lived in another Cloud API CRM are not in Graph.",
  };
}

export async function findOrCreateByWaId(input: {
  configId: string;
  waId: string;
  displayName?: string | null;
  businessName?: string | null;
}) {
  const waId = normalizeWaId(input.waId);
  if (!waId) throw new HttpError(404, "Invalid WhatsApp id");
  if (!input.configId) throw new HttpError(400, "WhatsApp config is required");

  let [conversation] = await db
    .select()
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.configId, input.configId),
        eq(whatsappConversations.waId, waId),
      ),
    )
    .limit(1);

  if (!conversation && waId.startsWith("974") && waId.length === 11) {
    const local = waId.slice(3);
    [conversation] = await db
      .select()
      .from(whatsappConversations)
      .where(
        and(
          eq(whatsappConversations.configId, input.configId),
          eq(whatsappConversations.waId, local),
        ),
      )
      .limit(1);
    if (conversation) {
      conversation.waId = waId;
    }
  }

  if (!conversation) {
    [conversation] = await db
      .insert(whatsappConversations)
      .values({
        configId: input.configId,
        waId,
        displayName: input.displayName || input.businessName || waId,
        businessName: input.businessName || null,
      })
      .returning();
    return conversation;
  }

  const [updated] = await db
    .update(whatsappConversations)
    .set({
      displayName: input.displayName || conversation.displayName,
      businessName: input.businessName || conversation.businessName,
      waId: conversation.waId,
      updatedAt: new Date(),
    })
    .where(eq(whatsappConversations.id, conversation.id))
    .returning();
  return updated;
}

export async function touchConversation(
  conversation: ConversationRow,
  preview: string,
  opts?: { inbound?: boolean; bumpUnread?: boolean; at?: Date },
) {
  const at = opts?.at && !Number.isNaN(opts.at.getTime()) ? opts.at : new Date();
  const prevAt = conversation.lastMessageAt ? new Date(conversation.lastMessageAt).getTime() : 0;
  const newer = !prevAt || at.getTime() >= prevAt;
  const [updated] = await db
    .update(whatsappConversations)
    .set({
      lastMessagePreview: newer ? preview.slice(0, 500) : conversation.lastMessagePreview,
      lastMessageAt: newer ? at : conversation.lastMessageAt,
      lastInboundAt: opts?.inbound
        ? newer || !conversation.lastInboundAt
          ? at
          : conversation.lastInboundAt
        : conversation.lastInboundAt,
      unreadCount: opts?.bumpUnread
        ? (conversation.unreadCount || 0) + 1
        : conversation.unreadCount,
      updatedAt: new Date(),
    })
    .where(eq(whatsappConversations.id, conversation.id))
    .returning();
  return updated;
}

export async function syncLastInboundAtById(conversationId: string) {
  const [latest] = await db
    .select({ createdAt: whatsappMessages.createdAt })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.conversationId, conversationId),
        eq(whatsappMessages.direction, "inbound"),
      ),
    )
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(1);
  if (!latest?.createdAt) return;
  await db
    .update(whatsappConversations)
    .set({ lastInboundAt: latest.createdAt, updatedAt: new Date() })
    .where(eq(whatsappConversations.id, conversationId));
}

export async function getMessageById(messageId: string) {
  const [m] = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.id, messageId))
    .limit(1);
  if (!m) throw new HttpError(404, "Message not found");
  return m;
}
