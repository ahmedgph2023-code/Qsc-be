import { normalizeWaId } from "./crypto.js";

/** Official Cloud API limits for chat history. Do not treat Graph as a message store. */
export const META_HISTORY_CAPABILITIES = {
  graphHasConversationList: false,
  graphHasMessageHistoryGet: false,
  historyWebhookMaxDays: 180,
  historyWebhookMediaDays: 14,
  historyWebhookIncludesGroups: false,
  historyWebhookTrigger:
    "WhatsApp Business app onboarding by a solution provider, with the business agreeing to share chat history",
} as const;

export const HISTORY_DECLINED_CODE = "2593109";

export type ParsedCloudMessage = {
  type: string;
  body: string | null;
  mediaId: string | null;
  mimeType: string | null;
  fileName: string | null;
  preview: string;
};

export type HistoryDecline = {
  code: string;
  title: string;
  message: string;
};

export type FlattenedHistoryMessage = {
  waId: string;
  displayName: string | null;
  direction: "inbound" | "outbound";
  wamid: string;
  timestamp: Date;
  status: string;
  parsed: ParsedCloudMessage;
  raw: Record<string, unknown>;
};

export type HistoryChunkMeta = {
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
};

export function mapDeliveryStatus(status: string | undefined): string | null {
  const s = String(status || "").trim().toUpperCase();
  if (s === "SENT") return "sent";
  if (s === "DELIVERED" || s === "PLAYED") return "delivered";
  if (s === "READ") return "read";
  if (s === "FAILED" || s === "ERROR") return "failed";
  if (s === "PENDING") return "pending";
  const lower = s.toLowerCase();
  if (lower === "sent" || lower === "delivered" || lower === "read" || lower === "failed" || lower === "pending") {
    return lower;
  }
  return null;
}

export function parseCloudMessageContent(msg: Record<string, unknown>): ParsedCloudMessage {
  const type = String(msg.type || "text").toLowerCase();
  let body: string | null = null;
  let mediaId: string | null = null;
  let mimeType: string | null = null;
  let fileName: string | null = null;
  let preview = "";

  if (type === "text") {
    body = String((msg.text as { body?: string })?.body || "");
    preview = body;
  } else if (type === "button") {
    body = String((msg.button as { text?: string })?.text || "");
    preview = body || "[Button]";
  } else if (type === "interactive") {
    const interactive = msg.interactive as Record<string, unknown> | undefined;
    body =
      String((interactive?.button_reply as { title?: string })?.title || "") ||
      String((interactive?.list_reply as { title?: string })?.title || "");
    preview = body || "[Interactive]";
  } else if (type === "media_placeholder") {
    preview = "[media]";
  } else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
    const bucket = msg[type] as {
      id?: string;
      mime_type?: string;
      filename?: string;
      caption?: string;
    };
    mediaId = bucket?.id ? String(bucket.id) : null;
    mimeType = bucket?.mime_type || null;
    fileName = bucket?.filename || null;
    body = bucket?.caption || null;
    preview = `[${type}]${body ? ` ${body}` : ""}`;
  } else {
    preview = `[${type}]`;
  }

  return { type, body, mediaId, mimeType, fileName, preview: preview || `[${type}]` };
}

export function shouldEnrichExisting(
  existing: { mediaId?: string | null; messageType?: string | null },
  incoming: ParsedCloudMessage,
): boolean {
  const placeholder = existing.messageType === "media_placeholder";
  const gainedMedia = !existing.mediaId && Boolean(incoming.mediaId);
  const gainedType = placeholder && incoming.type !== "media_placeholder";
  return gainedMedia || gainedType;
}

export function messageDirection(input: {
  from?: string | null;
  threadId?: string | null;
  to?: string | null;
  businessDisplayNumber?: string | null;
  forced?: "inbound" | "outbound" | null;
}): "inbound" | "outbound" {
  if (input.forced) return input.forced;
  const fromId = normalizeWaId(input.from);
  const threadId = normalizeWaId(input.threadId);
  const toId = normalizeWaId(input.to);
  const biz = normalizeWaId(input.businessDisplayNumber);
  if (threadId && fromId && fromId === threadId) return "inbound";
  if (biz && fromId && fromId === biz) return "outbound";
  if (toId && fromId && fromId !== toId) return "outbound";
  if (threadId && fromId && fromId !== threadId) return "outbound";
  return "inbound";
}

export function timestampFromUnix(value: unknown): Date {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function isMetaWebhookEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as { object?: string; entry?: unknown };
  if (Array.isArray(obj.entry) && obj.entry.length > 0) return true;
  if (obj.object === "whatsapp_business_account") return true;
  const value = (payload as { messaging_product?: string; metadata?: unknown }).messaging_product;
  if (value === "whatsapp" && (payload as { metadata?: unknown }).metadata) return true;
  return false;
}

export function webhookChanges(payload: unknown): Array<{ field: string; value: Record<string, unknown> }> {
  const out: Array<{ field: string; value: Record<string, unknown> }> = [];
  if (!payload || typeof payload !== "object") return out;
  const asValue = payload as { field?: string; value?: Record<string, unknown>; messaging_product?: string };
  if (asValue.messaging_product === "whatsapp" && asValue.value == null && !Array.isArray((payload as { entry?: unknown }).entry)) {
    out.push({ field: inferStandaloneField(asValue), value: asValue as Record<string, unknown> });
    return out;
  }
  const entries = Array.isArray((payload as { entry?: unknown[] }).entry)
    ? (payload as { entry: unknown[] }).entry
    : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown[] })?.changes)
      ? (entry as { changes: unknown[] }).changes
      : [];
    for (const change of changes) {
      const field = String((change as { field?: string })?.field || "messages");
      const value = ((change as { value?: Record<string, unknown> }).value || {}) as Record<string, unknown>;
      out.push({ field, value });
    }
  }
  return out;
}

function inferStandaloneField(value: Record<string, unknown>): string {
  if (Array.isArray(value.history)) return "history";
  if (Array.isArray(value.state_sync)) return "smb_app_state_sync";
  if (Array.isArray(value.statuses) && !Array.isArray(value.messages)) return "messages";
  return "messages";
}

export function parseHistoryDeclines(history: unknown[] | undefined): HistoryDecline[] {
  if (!Array.isArray(history)) return [];
  const declines: HistoryDecline[] = [];
  for (const block of history) {
    const errors = (block as { errors?: unknown[] })?.errors;
    if (!Array.isArray(errors)) continue;
    for (const err of errors) {
      const row = err as Record<string, unknown>;
      declines.push({
        code: String(row.code || ""),
        title: String(row.title || ""),
        message: String(row.message || row.title || "History sharing declined"),
      });
    }
  }
  return declines;
}

export function parseHistoryChunks(history: unknown[] | undefined): HistoryChunkMeta[] {
  if (!Array.isArray(history)) return [];
  return history
    .map((block) => {
      const meta = (block as { metadata?: Record<string, unknown> })?.metadata || {};
      const phase = meta.phase == null ? null : Number(meta.phase);
      const chunkOrder = meta.chunk_order == null ? null : Number(meta.chunk_order);
      const progress = meta.progress == null ? null : Number(meta.progress);
      if (phase == null && chunkOrder == null && progress == null) return null;
      return {
        phase: Number.isFinite(phase) ? phase : null,
        chunkOrder: Number.isFinite(chunkOrder) ? chunkOrder : null,
        progress: Number.isFinite(progress) ? progress : null,
      };
    })
    .filter((row): row is HistoryChunkMeta => row != null);
}

export function flattenHistoryThreads(
  history: unknown[] | undefined,
  businessDisplayNumber?: string | null,
  contacts?: unknown[],
): FlattenedHistoryMessage[] {
  if (!Array.isArray(history)) return [];
  const contactByWa = contactNameMap(contacts);
  const out: FlattenedHistoryMessage[] = [];
  for (const block of history) {
    const threads = (block as { threads?: unknown[] })?.threads;
    if (!Array.isArray(threads)) continue;
    for (const thread of threads) {
      const t = thread as { id?: string; messages?: unknown[] };
      const threadId = normalizeWaId(t.id);
      if (!threadId || !Array.isArray(t.messages)) continue;
      for (const msg of t.messages) {
        const flat = flattenOneMessage(msg, {
          threadId,
          businessDisplayNumber,
          displayName: contactByWa.get(threadId) || null,
        });
        if (flat) out.push(flat);
      }
    }
  }
  return out;
}

export function flattenStandaloneMessages(
  messages: unknown[] | undefined,
  opts: {
    businessDisplayNumber?: string | null;
    contacts?: unknown[];
    forcedDirection?: "inbound" | "outbound" | null;
  },
): FlattenedHistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  const contactByWa = contactNameMap(opts.contacts);
  const out: FlattenedHistoryMessage[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const fromId = normalizeWaId(m.from as string);
    const toId = normalizeWaId(m.to as string);
    const threadId =
      opts.forcedDirection === "outbound" ? toId : fromId || toId;
    if (!threadId) continue;
    const flat = flattenOneMessage(m, {
      threadId,
      businessDisplayNumber: opts.businessDisplayNumber,
      displayName: contactByWa.get(threadId) || null,
      forcedDirection: opts.forcedDirection,
    });
    if (flat) out.push(flat);
  }
  return out;
}

function flattenOneMessage(
  msg: unknown,
  ctx: {
    threadId: string;
    businessDisplayNumber?: string | null;
    displayName: string | null;
    forcedDirection?: "inbound" | "outbound" | null;
  },
): FlattenedHistoryMessage | null {
  const m = msg as Record<string, unknown>;
  const wamid = String(m.id || "").trim();
  if (!wamid) return null;
  const historyContext = m.history_context as { status?: string } | undefined;
  const status = mapDeliveryStatus(historyContext?.status) || "received";
  return {
    waId: ctx.threadId,
    displayName: ctx.displayName,
    direction: messageDirection({
      from: m.from as string,
      threadId: ctx.threadId,
      to: m.to as string,
      businessDisplayNumber: ctx.businessDisplayNumber,
      forced: ctx.forcedDirection,
    }),
    wamid,
    timestamp: timestampFromUnix(m.timestamp),
    status: ctx.forcedDirection === "inbound" && !historyContext ? "received" : status,
    parsed: parseCloudMessageContent(m),
    raw: m,
  };
}

export function contactNameMap(contacts: unknown[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of contacts || []) {
    const row = c as { wa_id?: string; profile?: { name?: string } };
    const id = normalizeWaId(row?.wa_id);
    const name = row?.profile?.name;
    if (id && name) map.set(id, name);
  }
  return map;
}

export type ParsedSmbContact = {
  waId: string;
  displayName: string | null;
  action: string;
};

export function parseSmbContacts(stateSync: unknown[] | undefined): ParsedSmbContact[] {
  if (!Array.isArray(stateSync)) return [];
  const out: ParsedSmbContact[] = [];
  for (const item of stateSync) {
    const row = item as {
      type?: string;
      action?: string;
      contact?: { full_name?: string; first_name?: string; phone_number?: string };
    };
    if (String(row.type || "").toLowerCase() !== "contact") continue;
    const phone = normalizeWaId(row.contact?.phone_number);
    if (!phone) continue;
    const name = String(row.contact?.full_name || row.contact?.first_name || "").trim() || null;
    out.push({
      waId: phone,
      displayName: name,
      action: String(row.action || "add").toLowerCase(),
    });
  }
  return out;
}

export const CLOUD_API_CANNOT_IMPORT = [
  {
    key: "chat_history_via_graph",
    reason:
      "WhatsApp Cloud API has no GET for conversations or message bodies. Past chats from another Cloud API CRM/BSP are not stored at Meta and cannot be pulled.",
  },
  {
    key: "contacts_directory",
    reason:
      "Cloud API does not expose a contact list. Names arrive only with inbound webhooks, smb_app_state_sync (Business app onboard), or a phone Excel you upload here.",
  },
  {
    key: "media_files_from_old_crm",
    reason:
      "Meta media IDs expire. History webhooks include media IDs only for the last 14 days of Business-app onboarding; older media is a placeholder with no file.",
  },
  {
    key: "group_chats",
    reason: "The history webhook does not include group chats.",
  },
] as const;
