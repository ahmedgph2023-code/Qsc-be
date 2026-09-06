import { eq, isNotNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappConfig } from "../db/schema/whatsapp.js";
import {
  decryptSecrets,
  encryptSecrets,
  hashVerifyToken,
  maskSecret,
  verifyTokenMatches,
  type WhatsAppSecrets,
} from "./crypto.js";
import * as cloudApi from "./cloud-api.js";
import { logWhatsAppActivity } from "./activity.js";
import { HttpError } from "./errors.js";

const WEBHOOK_PATH = "/api/whatsapp/webhook";

function buildWebhookCallbackUrl() {
  const base =
    process.env.META_WHATSAPP_PUBLIC_API_URL?.trim() ||
    process.env.PUBLIC_API_URL?.trim() ||
    "";
  if (!base) return WEBHOOK_PATH;
  const clean = base.replace(/\/$/, "");
  if (clean.endsWith("/api")) return `${clean}/whatsapp/webhook`;
  return `${clean}/api/whatsapp/webhook`;
}

function safeSecrets(cfg: typeof whatsappConfig.$inferSelect): WhatsAppSecrets | null {
  if (!cfg.encryptedCredentials) return null;
  try {
    return decryptSecrets(cfg.encryptedCredentials);
  } catch {
    return null;
  }
}

function publicStatus(cfg: typeof whatsappConfig.$inferSelect) {
  const secrets = safeSecrets(cfg);
  const webhookCallbackUrl = buildWebhookCallbackUrl();
  return {
    id: cfg.id,
    label: cfg.label,
    enabled: cfg.enabled,
    phoneNumberId: cfg.phoneNumberId,
    wabaId: cfg.wabaId,
    displayPhoneNumber: cfg.displayPhoneNumber,
    connectionStatus: cfg.enabled ? cfg.connectionStatus : "disabled",
    lastValidatedAt: cfg.lastValidatedAt,
    lastError: cfg.lastError,
    webhookPath: cfg.webhookPath,
    webhookCallbackUrl,
    webhookUrlHint: webhookCallbackUrl,
    verifyToken: secrets?.verifyToken || null,
    accessToken: secrets?.accessToken || null,
    appSecret: secrets?.appSecret || null,
    hasAccessToken: Boolean(secrets?.accessToken),
    accessTokenHint: maskSecret(secrets?.accessToken),
    hasAppSecret: Boolean(secrets?.appSecret),
    appSecretHint: maskSecret(secrets?.appSecret),
    hasVerifyToken: Boolean(secrets?.verifyToken),
    verifyTokenHint: maskSecret(secrets?.verifyToken),
    graphApiVersion: cloudApi.GRAPH_VERSION,
    updatedAt: cfg.updatedAt,
  };
}

export async function listWhatsAppAccounts() {
  const rows = await db.select().from(whatsappConfig).orderBy(whatsappConfig.createdAt);
  return rows.map(publicStatus);
}

export async function createWhatsAppAccount(label: string, actorId: string | null) {
  const trimmed = String(label || "").trim() || "WhatsApp";
  const [row] = await db
    .insert(whatsappConfig)
    .values({
      label: trimmed,
      webhookPath: WEBHOOK_PATH,
      updatedBy: actorId,
    })
    .returning();
  await logWhatsAppActivity("account.created", actorId, { label: trimmed }, row.id);
  return publicStatus(row);
}

export async function deleteWhatsAppAccount(configId: string, actorId: string | null) {
  const cfg = await getConfigRow(configId);
  await logWhatsAppActivity("account.deleted", actorId, { configId, label: cfg.label }, configId);
  await db.delete(whatsappConfig).where(eq(whatsappConfig.id, cfg.id));
  return { ok: true };
}

export async function getConfigRow(configId: string) {
  const [cfg] = await db
    .select()
    .from(whatsappConfig)
    .where(eq(whatsappConfig.id, configId))
    .limit(1);
  if (!cfg) throw new HttpError(404, "WhatsApp account not found");
  return cfg;
}

export async function getWhatsAppStatus(configId: string) {
  const cfg = await getConfigRow(configId);
  return publicStatus(cfg);
}

export type SaveConfigInput = {
  label?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  phoneNumberId?: string | null;
  wabaId?: string | null;
  enabled?: boolean;
};

export async function saveWhatsAppConfig(
  configId: string,
  dto: SaveConfigInput,
  actorId: string | null,
) {
  const cfg = await getConfigRow(configId);
  const current = safeSecrets(cfg) || { accessToken: "", appSecret: "", verifyToken: "" };

  if (dto.label?.trim()) cfg.label = dto.label.trim();
  if (dto.accessToken?.trim()) current.accessToken = dto.accessToken.trim();
  if (dto.appSecret?.trim()) current.appSecret = dto.appSecret.trim();
  if (dto.verifyToken?.trim()) {
    current.verifyToken = dto.verifyToken.trim();
    cfg.verifyTokenHash = hashVerifyToken(current.verifyToken);
  }
  if (dto.phoneNumberId !== undefined) {
    cfg.phoneNumberId = dto.phoneNumberId?.trim() || null;
  }
  if (dto.wabaId !== undefined) {
    cfg.wabaId = dto.wabaId?.trim() || null;
  }
  if (cfg.wabaId && cfg.phoneNumberId && cfg.wabaId === cfg.phoneNumberId) {
    throw new HttpError(
      400,
      "WABA ID cannot be the same as Phone Number ID. Copy WhatsApp Business Account ID into WABA ID.",
    );
  }
  if (dto.enabled !== undefined) cfg.enabled = Boolean(dto.enabled);
  if (!cfg.phoneNumberId) {
    throw new HttpError(400, "Phone Number ID is required");
  }

  const secretsComplete = Boolean(
    current.accessToken && current.verifyToken && current.appSecret,
  );
  const touchingSecrets = Boolean(
    dto.accessToken?.trim() || dto.appSecret?.trim() || dto.verifyToken?.trim(),
  );
  if (touchingSecrets && !secretsComplete) {
    throw new HttpError(
      400,
      "Access token, Verify token, and App secret are all required when updating credentials",
    );
  }
  if (secretsComplete) {
    cfg.encryptedCredentials = encryptSecrets(current);
    if (!cfg.verifyTokenHash && current.verifyToken) {
      cfg.verifyTokenHash = hashVerifyToken(current.verifyToken);
    }
  }

  cfg.updatedBy = actorId;
  cfg.lastError = null;
  cfg.updatedAt = new Date();

  const [saved] = await db
    .update(whatsappConfig)
    .set({
      label: cfg.label,
      enabled: cfg.enabled,
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId,
      verifyTokenHash: cfg.verifyTokenHash,
      encryptedCredentials: cfg.encryptedCredentials,
      updatedBy: cfg.updatedBy,
      lastError: cfg.lastError,
      updatedAt: cfg.updatedAt,
    })
    .where(eq(whatsappConfig.id, cfg.id))
    .returning();

  await logWhatsAppActivity(
    "config.saved",
    actorId,
    { phoneNumberId: saved.phoneNumberId, wabaId: saved.wabaId, enabled: saved.enabled },
    saved.id,
  );
  return publicStatus(saved);
}

export async function validateWhatsAppConfig(configId: string, actorId: string | null) {
  const runtime = requireRuntime(await getConfigRow(configId));
  const result = await cloudApi.validateCredentials({
    accessToken: runtime.secrets.accessToken,
    phoneNumberId: runtime.config.phoneNumberId!,
    wabaId: runtime.config.wabaId,
  });

  const [saved] = await db
    .update(whatsappConfig)
    .set({
      phoneNumberId: result.phoneNumberId,
      displayPhoneNumber: result.displayPhoneNumber,
      wabaId: result.wabaId,
      connectionStatus: "connected",
      lastValidatedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(whatsappConfig.id, configId))
    .returning();

  await logWhatsAppActivity("config.validated", actorId, result, configId);
  return { ...publicStatus(saved), validation: result };
}

export async function setWhatsAppEnabled(
  configId: string,
  enabled: boolean,
  actorId: string | null,
) {
  const cfg = await getConfigRow(configId);
  if (enabled) {
    requireRuntime(cfg, { requireSecrets: true });
  }
  const [saved] = await db
    .update(whatsappConfig)
    .set({
      enabled,
      connectionStatus: enabled ? cfg.connectionStatus : "disabled",
      updatedAt: new Date(),
    })
    .where(eq(whatsappConfig.id, configId))
    .returning();
  await logWhatsAppActivity("config.enabled", actorId, { enabled }, configId);
  return publicStatus(saved);
}

export type WhatsAppRuntime = {
  config: typeof whatsappConfig.$inferSelect;
  secrets: WhatsAppSecrets;
};

export function requireRuntime(
  config: typeof whatsappConfig.$inferSelect,
  options?: { requireEnabled?: boolean; requireSecrets?: boolean },
): WhatsAppRuntime {
  if (options?.requireEnabled && !config.enabled) {
    throw new HttpError(503, "WhatsApp integration is disabled for this number");
  }
  if (!config.encryptedCredentials || !config.phoneNumberId) {
    throw new HttpError(404, "WhatsApp is not configured for this number");
  }
  const secrets = decryptSecrets(config.encryptedCredentials);
  if (!secrets.accessToken) {
    throw new HttpError(404, "WhatsApp access token is missing");
  }
  return { config, secrets };
}

export async function requireRuntimeById(
  configId: string,
  options?: { requireEnabled?: boolean },
): Promise<WhatsAppRuntime> {
  const cfg = await getConfigRow(configId);
  return requireRuntime(cfg, options);
}

export async function resolveSecretsByPhoneNumberId(
  phoneNumberId: string,
): Promise<WhatsAppRuntime | null> {
  const id = String(phoneNumberId || "").trim();
  if (!id) return null;
  const [cfg] = await db
    .select()
    .from(whatsappConfig)
    .where(eq(whatsappConfig.phoneNumberId, id))
    .limit(1);
  if (!cfg?.encryptedCredentials) return null;
  try {
    return { config: cfg, secrets: decryptSecrets(cfg.encryptedCredentials) };
  } catch {
    return null;
  }
}

export async function resolveSecretsByVerifyToken(token: string): Promise<WhatsAppRuntime | null> {
  const rows = await db
    .select()
    .from(whatsappConfig)
    .where(isNotNull(whatsappConfig.encryptedCredentials))
    .limit(200);
  for (const config of rows) {
    const runtime = safeRuntime(config);
    if (!runtime) continue;
    const ok =
      verifyTokenMatches(token, config.verifyTokenHash) ||
      token === runtime.secrets.verifyToken;
    if (ok) return runtime;
  }
  return null;
}

function safeRuntime(config: typeof whatsappConfig.$inferSelect): WhatsAppRuntime | null {
  if (!config.encryptedCredentials) return null;
  try {
    return { config, secrets: decryptSecrets(config.encryptedCredentials) };
  } catch {
    return null;
  }
}

export async function listWhatsAppTemplates(configId: string) {
  const runtime = requireRuntime(await getConfigRow(configId));
  if (!runtime.config.wabaId) {
    throw new HttpError(400, "WABA ID is required to list templates. Validate connection first.");
  }
  return cloudApi.listMessageTemplates(runtime.secrets.accessToken, runtime.config.wabaId);
}

export async function assertConversationBelongsToConfig(
  conversationId: string,
  configId: string,
) {
  const { whatsappConversations } = await import("../db/schema/whatsapp.js");
  const [row] = await db
    .select({ configId: whatsappConversations.configId })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!row) throw new HttpError(404, "Conversation not found");
  if (row.configId !== configId) {
    throw new HttpError(403, "Conversation does not belong to the selected WhatsApp number");
  }
}
