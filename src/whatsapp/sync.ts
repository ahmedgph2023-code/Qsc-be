import { desc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappActivity } from "../db/schema/whatsapp.js";
import * as cloudApi from "./cloud-api.js";
import { requireRuntimeById } from "./config.js";
import { HttpError } from "./errors.js";
import { ingestWebhookPayload, localInboxCounts } from "./ingest.js";
import {
  CLOUD_API_CANNOT_IMPORT,
  HISTORY_DECLINED_CODE,
  META_HISTORY_CAPABILITIES,
  isMetaWebhookEnvelope,
} from "./ingest-parse.js";
import { logWhatsAppActivity } from "./activity.js";

export type SyncCapabilityItem = {
  key: string;
  available: boolean;
  reason: string;
};

export type MetaSyncReport = {
  ok: boolean;
  pulled: {
    phone: {
      phoneNumberId: string;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
      wabaId: string | null;
      wabaName: string | null;
    } | null;
    templates: { count: number };
    businessProfile: Record<string, unknown> | null;
    webhookSubscription: {
      subscribed: boolean;
      apps: unknown[];
      error: string | null;
    };
  };
  local: { conversations: number; messages: number };
  history: {
    availableViaGraphPull: false;
    webhookMaxDays: number;
    webhookMediaDays: number;
    lastChunk: unknown;
    lastDecline: unknown;
    note: string;
  };
  can: SyncCapabilityItem[];
  cannot: SyncCapabilityItem[];
};

export async function syncFromMeta(configId: string, actorId: string | null): Promise<MetaSyncReport> {
  const runtime = await requireRuntimeById(configId);
  const token = runtime.secrets.accessToken;
  const phoneNumberId = runtime.config.phoneNumberId;
  if (!phoneNumberId) throw new HttpError(400, "Phone Number ID is required");

  const phone = await cloudApi.validateCredentials({
    accessToken: token,
    phoneNumberId,
    wabaId: runtime.config.wabaId,
  });

  let templates: Awaited<ReturnType<typeof cloudApi.listMessageTemplates>> = [];
  if (phone.wabaId) {
    templates = await cloudApi.listMessageTemplates(token, phone.wabaId);
  }

  let businessProfile: Record<string, unknown> | null = null;
  try {
    businessProfile = await cloudApi.getBusinessProfile(token, phone.phoneNumberId);
  } catch {
    businessProfile = null;
  }

  let apps: unknown[] = [];
  let subscribed = false;
  let subscribeError: string | null = null;
  if (phone.wabaId) {
    try {
      apps = await cloudApi.listSubscribedApps(token, phone.wabaId);
      subscribed = apps.length > 0;
    } catch (err) {
      subscribeError = err instanceof Error ? err.message : "Could not list subscribed apps";
    }
    if (!subscribed) {
      try {
        await cloudApi.subscribeWabaApp(token, phone.wabaId);
        apps = await cloudApi.listSubscribedApps(token, phone.wabaId);
        subscribed = apps.length > 0;
      } catch (err) {
        subscribeError = err instanceof Error ? err.message : "Could not subscribe this app to the WABA";
      }
    }
  }

  const local = await localInboxCounts(configId);
  const { lastChunk, lastDecline } = await latestHistoryActivity(configId);

  const report: MetaSyncReport = {
    ok: true,
    pulled: {
      phone,
      templates: { count: templates.length },
      businessProfile,
      webhookSubscription: {
        subscribed,
        apps,
        error: subscribeError,
      },
    },
    local,
    history: {
      availableViaGraphPull: false,
      webhookMaxDays: META_HISTORY_CAPABILITIES.historyWebhookMaxDays,
      webhookMediaDays: META_HISTORY_CAPABILITIES.historyWebhookMediaDays,
      lastChunk,
      lastDecline,
      note: META_HISTORY_CAPABILITIES.historyWebhookTrigger,
    },
    can: [
      {
        key: "phone_waba_profile",
        available: true,
        reason: "Graph returns display number, verified name, quality rating, and WABA id.",
      },
      {
        key: "message_templates",
        available: true,
        reason: `Graph listed ${templates.length} message template(s) on this WABA.`,
      },
      {
        key: "business_profile",
        available: Boolean(businessProfile),
        reason: businessProfile
          ? "Graph returned the WhatsApp Business Profile for this phone."
          : "Business profile was not readable with this token.",
      },
      {
        key: "live_webhooks",
        available: subscribed,
        reason: subscribed
          ? "This app is subscribed to the WABA. New messages/statuses will store here from now on."
          : subscribeError || "Subscribe this app to the WABA in Meta and point the webhook at this system.",
      },
      {
        key: "history_webhook",
        available: false,
        reason:
          "Meta pushes history only when a solution provider onboards a WhatsApp Business app number and the business shares chats (180 days, no groups, media IDs for 14 days). This is not a pull API and does not run for a Cloud API number moved from another CRM.",
      },
      {
        key: "local_inbox",
        available: true,
        reason: `This system already stores ${local.conversations} conversation(s) and ${local.messages} message(s) for this number (webhook + sends).`,
      },
    ],
    cannot: CLOUD_API_CANNOT_IMPORT.map((row) => ({
      key: row.key,
      available: false,
      reason: row.reason,
    })),
  };

  await logWhatsAppActivity(
    "sync.meta",
    actorId,
    {
      templates: templates.length,
      conversations: local.conversations,
      messages: local.messages,
      subscribed,
    },
    configId,
  );

  return report;
}

export async function importMetaWebhookDump(
  configId: string,
  payload: unknown,
  actorId: string | null,
) {
  await requireRuntimeById(configId);
  const envelopes = normalizeImportPayload(payload);
  if (!envelopes.length) {
    throw new HttpError(
      400,
      "Not a Meta Cloud API webhook JSON. Export webhook payloads (object + entry + changes) from the old system. Graph cannot reconstruct chats from another CRM.",
    );
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let contacts = 0;
  let declines = 0;
  for (const envelope of envelopes) {
    const stats = await ingestWebhookPayload(configId, envelope, { bumpUnread: false });
    inserted += stats.inserted;
    updated += stats.updated;
    skipped += stats.skipped;
    contacts += stats.contacts;
    declines += stats.declines;
  }
  await logWhatsAppActivity(
    "sync.import_webhooks",
    actorId,
    { envelopes: envelopes.length, inserted, updated, skipped, contacts, declines },
    configId,
  );
  const local = await localInboxCounts(configId);
  return {
    ok: true,
    envelopes: envelopes.length,
    inserted,
    updated,
    skipped,
    contacts,
    declines,
    local,
  };
}

function normalizeImportPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload.filter(isMetaWebhookEnvelope);
  }
  if (isMetaWebhookEnvelope(payload)) return [payload];
  if (payload && typeof payload === "object" && isMetaWebhookEnvelope((payload as { payload?: unknown }).payload)) {
    return [(payload as { payload: unknown }).payload];
  }
  return [];
}

async function latestHistoryActivity(configId: string) {
  const rows = await db
    .select()
    .from(whatsappActivity)
    .where(eq(whatsappActivity.configId, configId))
    .orderBy(desc(whatsappActivity.createdAt))
    .limit(80);
  const lastChunk = rows.find((r) => r.event === "webhook.history_chunk")?.payload ?? null;
  const lastDecline = rows.find((r) => r.event === "webhook.history_declined")?.payload ?? null;
  return { lastChunk, lastDecline };
}
