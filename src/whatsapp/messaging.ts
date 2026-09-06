import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappMessages } from "../db/schema/whatsapp.js";
import * as cloudApi from "./cloud-api.js";
import { isWithinCustomerCareWindow, normalizeWaId } from "./crypto.js";
import { HttpError } from "./errors.js";
import {
  requireRuntimeById,
  listWhatsAppTemplates,
  assertConversationBelongsToConfig,
} from "./config.js";
import {
  findOrCreateByWaId,
  touchConversation,
  serializeMessage,
  resolveCustomerCareWindow,
  getMessageById,
} from "./conversations.js";
import { logWhatsAppActivity } from "./activity.js";
import { whatsappConversations } from "../db/schema/whatsapp.js";

const URL_BUTTON_PARAM_SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

export function assertValidTemplateUrlButtonParams(
  templateComponents: unknown[] | null | undefined,
  sendComponents?: unknown[] | null,
) {
  const send = Array.isArray(sendComponents) ? sendComponents : [];
  const buttonSends = send.filter(
    (c) =>
      String((c as { type?: string })?.type || "").toLowerCase() === "button" &&
      String((c as { sub_type?: string })?.sub_type || "").toLowerCase() === "url",
  );
  if (!buttonSends.length) return;

  const tplButtons =
    (Array.isArray(templateComponents)
      ? (
          templateComponents.find(
            (c) => String((c as { type?: string })?.type || "").toUpperCase() === "BUTTONS",
          ) as { buttons?: unknown[] } | undefined
        )?.buttons
      : null) || [];

  for (const btnSend of buttonSends) {
    const idx = Number((btnSend as { index?: number }).index ?? 0);
    const param = String(
      (btnSend as { parameters?: Array<{ text?: string }> })?.parameters?.[0]?.text || "",
    ).trim();
    if (!param) throw new HttpError(400, "URL button parameter is required");
    if (/\s/.test(param) || /[^\x00-\x7F]/.test(param) || !URL_BUTTON_PARAM_SAFE.test(param)) {
      throw new HttpError(
        400,
        "URL button parameter is invalid. Use only Latin letters, numbers, and URL-safe characters.",
      );
    }
    const urlTemplate = String((tplButtons[idx] as { url?: string })?.url || "");
    if (urlTemplate.includes("{{")) {
      const filled = urlTemplate.replace(/\{\{\s*[\w]+\s*\}\}/g, () => param);
      try {
        const u = new URL(filled);
        if (!/^https?:$/i.test(u.protocol)) throw new Error("bad protocol");
      } catch {
        throw new HttpError(400, `URL button parameter generates an invalid URL for Button ${idx + 1}.`);
      }
    }
  }
}

export function renderFilledTemplateText(
  templateComponents: unknown[] | null | undefined,
  sendComponents?: unknown[] | null,
): string | null {
  const comps = Array.isArray(templateComponents) ? templateComponents : [];
  const header = comps.find((c) => String((c as { type?: string }).type || "").toUpperCase() === "HEADER");
  const body = comps.find((c) => String((c as { type?: string }).type || "").toUpperCase() === "BODY");
  const footer = comps.find((c) => String((c as { type?: string }).type || "").toUpperCase() === "FOOTER");

  const send = Array.isArray(sendComponents) ? sendComponents : [];
  const sendHeader = send.find((c) => String((c as { type?: string }).type || "").toLowerCase() === "header");
  const sendBody = send.find((c) => String((c as { type?: string }).type || "").toLowerCase() === "body");

  const fill = (text: string | undefined, params: Array<{ text?: string; parameter_name?: string }> | undefined) => {
    if (!text) return "";
    const list = Array.isArray(params) ? params : [];
    return String(text)
      .replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => {
        const idx = Number(n) - 1;
        return list[idx]?.text != null ? String(list[idx].text) : `{{${n}}}`;
      })
      .replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_m, name) => {
        const hit = list.find((p) => p?.parameter_name === name);
        return hit?.text != null ? String(hit.text) : `{{${name}}}`;
      });
  };

  const parts = [
    fill((header as { text?: string })?.text, (sendHeader as { parameters?: unknown[] })?.parameters as never),
    fill((body as { text?: string })?.text, (sendBody as { parameters?: unknown[] })?.parameters as never),
    (footer as { text?: string })?.text ? String((footer as { text?: string }).text) : "",
  ].filter(Boolean);

  if (parts.length) return parts.join("\n");
  const bodyParams = (sendBody as { parameters?: Array<{ text?: string }> })?.parameters || [];
  if (bodyParams.length) return bodyParams.map((p) => p?.text).filter(Boolean).join(" ");
  return null;
}

async function resolveTarget(
  configId: string,
  input: { conversationId?: string; phone?: string; displayName?: string },
) {
  if (input.conversationId) {
    await assertConversationBelongsToConfig(input.conversationId, configId);
    const [conversation] = await db
      .select()
      .from(whatsappConversations)
      .where(eq(whatsappConversations.id, input.conversationId))
      .limit(1);
    if (!conversation) throw new HttpError(404, "Conversation not found");
    return { conversation };
  }
  const waId = normalizeWaId(input.phone);
  if (!waId) throw new HttpError(400, "Phone or conversationId is required");
  const conversation = await findOrCreateByWaId({
    configId,
    waId,
    displayName: input.displayName || waId,
  });
  return { conversation };
}

function assertFreeformAllowed(lastInboundAt: Date | null | undefined) {
  if (!isWithinCustomerCareWindow(lastInboundAt)) {
    throw new HttpError(
      400,
      "Free-form messages are only allowed within 24 hours of the customer's last message. Send an approved template instead.",
    );
  }
}

async function failMessage(messageId: string, error: unknown) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const [updated] = await db
    .update(whatsappMessages)
    .set({
      status: "failed",
      errorMessage: errMsg,
      updatedAt: new Date(),
    })
    .where(eq(whatsappMessages.id, messageId))
    .returning();
  throw new HttpError(400, errMsg);
}

export async function sendTextMessage(
  configId: string,
  actorId: string | null,
  input: { conversationId?: string; phone?: string; displayName?: string; text: string },
) {
  const text = String(input.text || "").trim();
  if (!text) throw new HttpError(400, "Message text is required");

  const { conversation } = await resolveTarget(configId, input);
  const care = await resolveCustomerCareWindow(conversation.id, conversation);
  assertFreeformAllowed(care.lastInboundAt);

  const runtime = await requireRuntimeById(configId, { requireEnabled: true });

  const [message] = await db
    .insert(whatsappMessages)
    .values({
      conversationId: conversation.id,
      direction: "outbound",
      messageType: "text",
      body: text,
      status: "queued",
      sentBy: actorId,
    })
    .returning();

  try {
    const sent = await cloudApi.sendText(
      runtime.secrets.accessToken,
      runtime.config.phoneNumberId!,
      conversation.waId,
      text,
    );
    const [updated] = await db
      .update(whatsappMessages)
      .set({
        wamid: sent.wamid,
        status: "sent",
        rawPayload: sent.raw,
        updatedAt: new Date(),
      })
      .where(eq(whatsappMessages.id, message.id))
      .returning();
    await touchConversation(conversation, text);
    await logWhatsAppActivity(
      "message.sent.text",
      actorId,
      { conversationId: conversation.id, wamid: sent.wamid },
      configId,
    );
    return serializeMessage(updated);
  } catch (error) {
    await failMessage(message.id, error);
    throw error;
  }
}

export async function sendTemplateMessage(
  configId: string,
  actorId: string | null,
  input: {
    conversationId?: string;
    phone?: string;
    displayName?: string;
    templateName: string;
    language?: string;
    components?: unknown[];
  },
) {
  const templateName = String(input.templateName || "").trim();
  if (!templateName) throw new HttpError(400, "Template name is required");
  const language = (input.language || "en").trim();

  const { conversation } = await resolveTarget(configId, input);
  const runtime = await requireRuntimeById(configId, { requireEnabled: true });

  let templateDef: { components?: unknown[]; language?: string } | null = null;
  let previewBody = "";
  try {
    const templates = await listWhatsAppTemplates(configId);
    templateDef =
      templates.find((t) => t.name === templateName && String(t.language || "") === language) ||
      templates.find((t) => t.name === templateName) ||
      null;
    previewBody = renderFilledTemplateText(templateDef?.components, input.components) || "";
  } catch {
    previewBody = "";
  }
  assertValidTemplateUrlButtonParams(templateDef?.components, input.components);
  if (!previewBody) {
    previewBody = renderFilledTemplateText(null, input.components) || templateName;
  }

  const [message] = await db
    .insert(whatsappMessages)
    .values({
      conversationId: conversation.id,
      direction: "outbound",
      messageType: "template",
      body: previewBody,
      templateName,
      templateLanguage: language,
      templateComponents: { v: 2, send: input.components || [] },
      status: "queued",
      sentBy: actorId,
    })
    .returning();

  try {
    const sent = await cloudApi.sendTemplate(
      runtime.secrets.accessToken,
      runtime.config.phoneNumberId!,
      conversation.waId,
      templateName,
      language,
      input.components,
    );
    const [updated] = await db
      .update(whatsappMessages)
      .set({
        wamid: sent.wamid,
        status: "sent",
        rawPayload: sent.raw,
        updatedAt: new Date(),
      })
      .where(eq(whatsappMessages.id, message.id))
      .returning();
    await touchConversation(conversation, previewBody);
    await logWhatsAppActivity(
      "message.sent.template",
      actorId,
      { conversationId: conversation.id, templateName, wamid: sent.wamid },
      configId,
    );
    return serializeMessage(updated);
  } catch (error) {
    await failMessage(message.id, error);
    throw error;
  }
}

function guessMediaMessageType(mimeType: string, asVoice: boolean) {
  if (asVoice) return "voice";
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export async function sendMediaMessage(
  configId: string,
  actorId: string | null,
  input: {
    conversationId?: string;
    phone?: string;
    displayName?: string;
    caption?: string;
    asVoice?: boolean;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  },
) {
  if (!input.buffer?.length) throw new HttpError(400, "File is required");
  const mimeType = input.mimeType || "application/octet-stream";
  const fileName = input.fileName || "file";
  const messageType = guessMediaMessageType(mimeType, Boolean(input.asVoice));
  const caption = String(input.caption || "").trim();

  const { conversation } = await resolveTarget(configId, input);
  const care = await resolveCustomerCareWindow(conversation.id, conversation);
  assertFreeformAllowed(care.lastInboundAt);

  const runtime = await requireRuntimeById(configId, { requireEnabled: true });
  const preview =
    caption ||
    (messageType === "image"
      ? "Photo"
      : messageType === "video"
        ? "Video"
        : messageType === "voice" || messageType === "audio"
          ? "Voice message"
          : fileName);

  const [message] = await db
    .insert(whatsappMessages)
    .values({
      conversationId: conversation.id,
      direction: "outbound",
      messageType,
      body: caption || preview,
      status: "queued",
      sentBy: actorId,
      mediaMimeType: mimeType,
      mediaFileName: fileName,
    })
    .returning();

  try {
    const uploaded = await cloudApi.uploadMedia(
      runtime.secrets.accessToken,
      runtime.config.phoneNumberId!,
      input.buffer,
      mimeType,
      fileName,
    );

    let sent;
    if (messageType === "image") {
      sent = await cloudApi.sendImageById(
        runtime.secrets.accessToken,
        runtime.config.phoneNumberId!,
        conversation.waId,
        uploaded.mediaId,
        caption || undefined,
      );
    } else if (messageType === "video") {
      sent = await cloudApi.sendVideoById(
        runtime.secrets.accessToken,
        runtime.config.phoneNumberId!,
        conversation.waId,
        uploaded.mediaId,
        caption || undefined,
      );
    } else if (messageType === "audio" || messageType === "voice") {
      sent = await cloudApi.sendAudioById(
        runtime.secrets.accessToken,
        runtime.config.phoneNumberId!,
        conversation.waId,
        uploaded.mediaId,
      );
    } else {
      sent = await cloudApi.sendDocumentById(
        runtime.secrets.accessToken,
        runtime.config.phoneNumberId!,
        conversation.waId,
        uploaded.mediaId,
        fileName,
        caption || undefined,
      );
    }

    const [updated] = await db
      .update(whatsappMessages)
      .set({
        wamid: sent.wamid,
        mediaId: uploaded.mediaId,
        status: "sent",
        rawPayload: sent.raw,
        updatedAt: new Date(),
      })
      .where(eq(whatsappMessages.id, message.id))
      .returning();
    await touchConversation(conversation, preview);
    await logWhatsAppActivity(
      "message.sent.media",
      actorId,
      { conversationId: conversation.id, messageType, wamid: sent.wamid },
      configId,
    );
    return serializeMessage(updated);
  } catch (error) {
    await failMessage(message.id, error);
    throw error;
  }
}

export async function getMessageMedia(configId: string, messageId: string) {
  const message = await getMessageById(messageId);
  await assertConversationBelongsToConfig(message.conversationId, configId);
  const runtime = await requireRuntimeById(configId);

  if (message.mediaUrl) {
    return { buffer: null, mimeType: message.mediaMimeType || "application/octet-stream", localPath: message.mediaUrl };
  }
  if (!message.mediaId) throw new HttpError(404, "Message has no media");

  const meta = await cloudApi.getMediaUrl(runtime.secrets.accessToken, message.mediaId);
  if (!meta.url) throw new HttpError(404, "Media URL not available");
  const buffer = await cloudApi.downloadMedia(runtime.secrets.accessToken, meta.url);
  return {
    buffer,
    mimeType: meta.mime_type || message.mediaMimeType || "application/octet-stream",
    localPath: null,
  };
}
