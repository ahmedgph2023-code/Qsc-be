import { Router, type Request } from "express";
import multer from "multer";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { errStatus, HttpError } from "../whatsapp/errors.js";
import {
  listWhatsAppAccounts,
  createWhatsAppAccount,
  deleteWhatsAppAccount,
  getWhatsAppStatus,
  saveWhatsAppConfig,
  validateWhatsAppConfig,
  setWhatsAppEnabled,
  listWhatsAppTemplates,
} from "../whatsapp/config.js";
import { listWhatsAppActivity } from "../whatsapp/activity.js";
import {
  listConversations,
  conversationFilterCounts,
  getConversation,
  listMessages,
  markConversationRead,
  setConversationFavorite,
  openPhoneConversation,
} from "../whatsapp/conversations.js";
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  getMessageMedia,
} from "../whatsapp/messaging.js";
import {
  createWhatsAppTemplate,
  updateWhatsAppTemplate,
  deleteWhatsAppTemplate,
  listTemplateLibrary,
  createTemplateFromLibrary,
  uploadTemplateHeader,
} from "../whatsapp/templates.js";
import {
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
} from "../whatsapp/quick-replies.js";
import { getUsageBilling } from "../whatsapp/usage.js";
import { verifyWebhookChallenge, handleWebhook } from "../whatsapp/webhook.js";
import { parseWhatsAppPhoneWorkbook, sendWhatsAppPhoneTemplate } from "../whatsapp/phone-import.js";
import { importMetaWebhookDump, syncFromMeta } from "../whatsapp/sync.js";

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

function actorId(req: AuthRequest) {
  return req.adminId ?? req.userId ?? null;
}

function configIdFrom(req: Request): string {
  const id = String(req.query.configId || req.body?.configId || "").trim();
  if (!id) throw new HttpError(400, "configId query parameter is required");
  return id;
}

const router = Router();

/** Webhook — no auth; mounted with raw body parser in app.ts */
export const webhookRouter = Router();

webhookRouter.get("/", async (req, res) => {
  try {
    const challenge = await verifyWebhookChallenge(req.query as Record<string, string | undefined>);
    res.status(200).send(challenge);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Verification failed" });
  }
});

webhookRouter.post("/", async (req: Request, res) => {
  try {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const result = await handleWebhook(
      rawBody,
      req.headers["x-hub-signature-256"] as string | undefined,
      req.body,
    );
    res.json(result);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Webhook failed" });
  }
});

router.use(authMiddleware, requireRole("admin", "pm"));

router.get("/accounts", async (_req, res) => {
  try {
    res.json({ accounts: await listWhatsAppAccounts() });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.post("/accounts", async (req: AuthRequest, res) => {
  try {
    const label = String(req.body?.label || "WhatsApp");
    res.status(201).json(await createWhatsAppAccount(label, actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

router.delete("/accounts/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await deleteWhatsAppAccount(String(req.params.id), actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});

router.get("/status", async (req, res) => {
  try {
    res.json(await getWhatsAppStatus(configIdFrom(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.put("/config", async (req: AuthRequest, res) => {
  try {
    res.json(await saveWhatsAppConfig(configIdFrom(req), req.body, actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Save failed" });
  }
});

router.post("/config/validate", async (req: AuthRequest, res) => {
  try {
    res.json(await validateWhatsAppConfig(configIdFrom(req), actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Validate failed" });
  }
});

router.post("/config/enable", async (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    res.json(await setWhatsAppEnabled(configIdFrom(req), enabled, actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Enable failed" });
  }
});

router.post("/sync", async (req: AuthRequest, res) => {
  try {
    res.json(await syncFromMeta(configIdFrom(req), actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Sync failed" });
  }
});

router.post("/sync/import-webhooks", mediaUpload.single("file"), async (req: AuthRequest, res) => {
  try {
    let payload: unknown = req.body?.payload ?? req.body;
    const file = req.file;
    if (file?.buffer?.length) {
      try {
        payload = JSON.parse(file.buffer.toString("utf8"));
      } catch {
        throw new HttpError(400, "Could not parse that JSON file");
      }
    }
    res.json(await importMetaWebhookDump(configIdFrom(req), payload, actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Import failed" });
  }
});

router.get("/templates", async (req, res) => {
  try {
    res.json({ templates: await listWhatsAppTemplates(configIdFrom(req)) });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Templates failed" });
  }
});

router.get("/templates/library", async (req, res) => {
  try {
    const search = String(req.query.search || "");
    const language = String(req.query.language || "");
    const templates = await listTemplateLibrary(configIdFrom(req), {
      search: search || undefined,
      language: language || undefined,
    });
    res.json({ templates, data: templates });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Library failed" });
  }
});

router.post("/templates/from-library", async (req: AuthRequest, res) => {
  try {
    res.json(await createTemplateFromLibrary(configIdFrom(req), actorId(req), req.body || {}));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

router.post("/templates/header", mediaUpload.single("file"), async (req: AuthRequest, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) throw new HttpError(400, "Sample media file is required");
    res.json(
      await uploadTemplateHeader(configIdFrom(req), actorId(req), {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      }),
    );
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Upload failed" });
  }
});

router.post("/templates", async (req: AuthRequest, res) => {
  try {
    res.status(201).json(await createWhatsAppTemplate(configIdFrom(req), actorId(req), req.body || {}));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

router.post("/templates/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await updateWhatsAppTemplate(configIdFrom(req), actorId(req), String(req.params.id), req.body || {}));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.delete("/templates", async (req: AuthRequest, res) => {
  try {
    const name = String(req.query.name || req.body?.name || "");
    const hsmId = String(req.query.hsmId || req.body?.hsmId || "");
    res.json(await deleteWhatsAppTemplate(configIdFrom(req), actorId(req), { name, hsmId }));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});

router.get("/usage", async (req, res) => {
  try {
    res.json(await getUsageBilling(configIdFrom(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Usage failed" });
  }
});

router.get("/quick-replies", async (req, res) => {
  try {
    res.json({ replies: await listQuickReplies(configIdFrom(req)) });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.post("/quick-replies", async (req: AuthRequest, res) => {
  try {
    res.status(201).json(await createQuickReply(configIdFrom(req), actorId(req), req.body || {}));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

router.put("/quick-replies/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await updateQuickReply(configIdFrom(req), String(req.params.id), actorId(req), req.body || {}));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.delete("/quick-replies/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await deleteQuickReply(configIdFrom(req), String(req.params.id), actorId(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json({ activity: await listWhatsAppActivity(configIdFrom(req), limit) });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Activity failed" });
  }
});

router.get("/conversations", async (req, res) => {
  try {
    const configId = configIdFrom(req);
    const q = String(req.query.q || "");
    const limit = Number(req.query.limit) || 50;
    const filter = String(req.query.filter || "all");
    res.json({
      conversations: await listConversations(configId, q, limit, filter),
    });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.get("/conversations/counts", async (req, res) => {
  try {
    res.json(await conversationFilterCounts(configIdFrom(req)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Counts failed" });
  }
});

router.post("/conversations/open-phone", async (req: AuthRequest, res) => {
  try {
    const configId = configIdFrom(req);
    const { phone, displayName } = req.body || {};
    res.json(await openPhoneConversation(configId, phone, displayName));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Open failed" });
  }
});

router.get("/conversations/phone-template", async (_req, res) => {
  try {
    sendWhatsAppPhoneTemplate(res);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Template failed" });
  }
});

router.post("/conversations/phone-import/preview", mediaUpload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      throw new HttpError(400, "Excel file is required");
    }
    try {
      res.json({ rows: parseWhatsAppPhoneWorkbook(file.buffer) });
    } catch {
      throw new HttpError(400, "Could not read that Excel file");
    }
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Parse failed" });
  }
});

router.get("/conversations/:id", async (req, res) => {
  try {
    res.json(await getConversation(configIdFrom(req), String(req.params.id)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json({
      messages: await listMessages(configIdFrom(req), String(req.params.id), limit),
    });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Messages failed" });
  }
});

router.post("/conversations/:id/read", async (req, res) => {
  try {
    res.json(await markConversationRead(configIdFrom(req), String(req.params.id)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Read failed" });
  }
});

router.put("/conversations/:id/favorite", async (req, res) => {
  try {
    res.json(
      await setConversationFavorite(
        configIdFrom(req),
        String(req.params.id),
        Boolean(req.body?.isFavorite),
      ),
    );
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Favorite failed" });
  }
});

router.post("/messages/text", async (req: AuthRequest, res) => {
  try {
    const configId = configIdFrom(req);
    res.json(await sendTextMessage(configId, actorId(req), req.body));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Send failed" });
  }
});

router.post("/messages/template", async (req: AuthRequest, res) => {
  try {
    const configId = configIdFrom(req);
    res.json(await sendTemplateMessage(configId, actorId(req), req.body));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Send failed" });
  }
});

router.post("/messages/media", mediaUpload.single("file"), async (req: AuthRequest, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) throw new HttpError(400, "File is required");
    const asVoiceRaw = req.body?.asVoice;
    res.json(
      await sendMediaMessage(configIdFrom(req), actorId(req), {
        conversationId: req.body?.conversationId,
        phone: req.body?.phone,
        displayName: req.body?.displayName,
        caption: req.body?.caption,
        asVoice: asVoiceRaw === true || asVoiceRaw === "true" || asVoiceRaw === "1",
        buffer: file.buffer,
        mimeType: file.mimetype,
        fileName: file.originalname,
      }),
    );
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Send failed" });
  }
});

router.get("/messages/:id/media", async (req, res) => {
  try {
    const configId = configIdFrom(req);
    const media = await getMessageMedia(configId, String(req.params.id));
    if (!media.buffer) {
      res.status(404).json({ error: "Media not available" });
      return;
    }
    res.setHeader("Content-Type", media.mimeType);
    res.send(media.buffer);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Media failed" });
  }
});

export default router;
