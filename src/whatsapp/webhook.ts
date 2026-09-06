import { verifyMetaSignature } from "./crypto.js";
import { resolveSecretsByPhoneNumberId, resolveSecretsByVerifyToken } from "./config.js";
import { logWhatsAppActivity } from "./activity.js";
import { HttpError } from "./errors.js";
import { ingestWebhookChange, type IngestStats } from "./ingest.js";
import { webhookChanges } from "./ingest-parse.js";

export async function verifyWebhookChallenge(query: Record<string, string | undefined>) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || !token || !challenge) {
    throw new HttpError(401, "Invalid webhook verification request");
  }
  const runtime = await resolveSecretsByVerifyToken(token);
  if (!runtime) throw new HttpError(401, "Verify token mismatch");
  await logWhatsAppActivity("webhook.verified", null, {}, runtime.config.id);
  return challenge;
}

export async function handleWebhook(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
  payload: unknown,
) {
  const parsed =
    payload && typeof payload === "object"
      ? payload
      : parseWebhookJson(rawBody);
  const phoneNumberId = extractPhoneNumberId(parsed);
  const runtime = phoneNumberId
    ? await resolveSecretsByPhoneNumberId(phoneNumberId)
    : null;
  if (!runtime?.secrets.appSecret) {
    throw new HttpError(401, "App secret not configured for this phone number");
  }
  if (!rawBody || (Buffer.isBuffer(rawBody) && rawBody.length === 0)) {
    await logWhatsAppActivity("webhook.raw_body_missing", null, {}, runtime.config.id);
    throw new HttpError(401, "Missing raw request body for signature verification");
  }
  const valid = verifyMetaSignature(rawBody, signatureHeader, runtime.secrets.appSecret);
  if (!valid) {
    await logWhatsAppActivity(
      "webhook.signature_invalid",
      null,
      { hasSignature: Boolean(signatureHeader) },
      runtime.config.id,
    );
    throw new HttpError(401, "Invalid Meta signature");
  }

  if (!runtime.config.enabled) {
    return { ok: true, processed: 0, skipped: true };
  }

  const totals = { inserted: 0, updated: 0, skipped: 0, contacts: 0, declines: 0 };
  for (const change of webhookChanges(parsed)) {
    const stats = await ingestWebhookChange(runtime.config.id, change.field, change.value, {
      bumpUnread: change.field === "messages",
    });
    addIngest(totals, stats);
  }

  return {
    ok: true,
    processed: totals.inserted + totals.updated + totals.contacts,
    inbound: totals.inserted,
    statuses: totals.updated,
    contacts: totals.contacts,
    historyDeclined: totals.declines,
  };
}

function addIngest(totals: IngestStats, stats: IngestStats) {
  totals.inserted += stats.inserted;
  totals.updated += stats.updated;
  totals.skipped += stats.skipped;
  totals.contacts += stats.contacts;
  totals.declines += stats.declines;
}

function parseWebhookJson(rawBody: Buffer | string | undefined): unknown {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractPhoneNumberId(payload: unknown): string | null {
  const entries = Array.isArray((payload as { entry?: unknown[] })?.entry)
    ? (payload as { entry: unknown[] }).entry
    : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown[] })?.changes)
      ? (entry as { changes: unknown[] }).changes
      : [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> }).value || {};
      const metadata = value.metadata as Record<string, unknown> | undefined;
      const id =
        metadata?.phone_number_id ||
        metadata?.phoneNumberId ||
        value.phone_number_id;
      if (id) return String(id);
    }
  }
  const standalone = payload as { metadata?: { phone_number_id?: string } };
  if (standalone?.metadata?.phone_number_id) return String(standalone.metadata.phone_number_id);
  return null;
}
