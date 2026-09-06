import { requireRuntimeById } from "./config.js";
import * as cloudApi from "./cloud-api.js";
import { HttpError } from "./errors.js";
import { logWhatsAppActivity } from "./activity.js";
import {
  buildMessageTemplateComponents,
  type TemplateButtonInput,
  type TemplateComponentInput,
} from "./template-payload.js";

function requireWaba(runtime: Awaited<ReturnType<typeof requireRuntimeById>>) {
  const wabaId = String(runtime.config.wabaId || "").trim();
  if (!wabaId) throw new HttpError(400, "WABA ID is required. Validate the connection first.");
  return wabaId;
}

export async function createWhatsAppTemplate(
  configId: string,
  actorId: string | null,
  dto: TemplateComponentInput & { name: string; language?: string; category?: string },
) {
  const runtime = await requireRuntimeById(configId);
  const wabaId = requireWaba(runtime);
  const name = String(dto.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!name || name.length < 3) {
    throw new HttpError(400, "Template name must be at least 3 chars (lowercase letters, numbers, underscores)");
  }
  const category = String(dto.category || "UTILITY").toUpperCase();
  if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(category)) {
    throw new HttpError(400, "Category must be UTILITY, MARKETING, or AUTHENTICATION");
  }
  const language = String(dto.language || "en_US").trim() || "en_US";
  const components = buildMessageTemplateComponents(dto);
  const created = await cloudApi.createMessageTemplate(runtime.secrets.accessToken, wabaId, {
    name,
    language,
    category,
    components,
  });
  await logWhatsAppActivity(
    "template.created",
    actorId,
    { name, language, category, id: created?.id, status: created?.status },
    configId,
  );
  return { ...created, name: created?.name || name, language: created?.language || language, category };
}

export async function updateWhatsAppTemplate(
  configId: string,
  actorId: string | null,
  templateId: string,
  dto: TemplateComponentInput,
) {
  const runtime = await requireRuntimeById(configId);
  const id = String(templateId || "").trim();
  if (!id) throw new HttpError(400, "Template id is required");
  const components = buildMessageTemplateComponents(dto);
  const updated = await cloudApi.editMessageTemplate(runtime.secrets.accessToken, id, components);
  await logWhatsAppActivity("template.updated", actorId, { templateId: id, status: updated?.status }, configId);
  return { ...updated, id };
}

export async function deleteWhatsAppTemplate(
  configId: string,
  actorId: string | null,
  input: { name?: string; hsmId?: string },
) {
  const runtime = await requireRuntimeById(configId);
  const wabaId = requireWaba(runtime);
  const name = String(input.name || "").trim();
  if (!name) throw new HttpError(400, "Template name is required to delete");
  const result = await cloudApi.deleteMessageTemplate(runtime.secrets.accessToken, wabaId, {
    name,
    hsmId: input.hsmId,
  });
  await logWhatsAppActivity("template.deleted", actorId, { name, hsmId: input.hsmId }, configId);
  return result;
}

export async function listTemplateLibrary(
  configId: string,
  options?: { search?: string; language?: string },
) {
  const runtime = await requireRuntimeById(configId);
  return cloudApi.listMessageTemplateLibrary(runtime.secrets.accessToken, options);
}

export async function createTemplateFromLibrary(
  configId: string,
  actorId: string | null,
  input: {
    name: string;
    language?: string;
    category?: string;
    libraryTemplateName: string;
    buttons?: TemplateButtonInput[];
    buttonUrl?: string;
    buttonPhone?: string;
  },
) {
  const runtime = await requireRuntimeById(configId);
  const wabaId = requireWaba(runtime);
  const created = await cloudApi.createMessageTemplateFromLibrary(
    runtime.secrets.accessToken,
    wabaId,
    {
      ...input,
      buttonPhone: input.buttonPhone || runtime.config.displayPhoneNumber || undefined,
    },
  );
  await logWhatsAppActivity(
    "template.library_created",
    actorId,
    { name: input.name, libraryTemplateName: input.libraryTemplateName, id: created?.id },
    configId,
  );
  return created;
}

export async function uploadTemplateHeader(
  configId: string,
  actorId: string | null,
  file: { buffer: Buffer; mimetype?: string; originalname?: string },
) {
  const runtime = await requireRuntimeById(configId);
  const wabaId = requireWaba(runtime);
  if (!file?.buffer?.length) throw new HttpError(400, "Sample media file is required");
  const mime = String(file.mimetype || "application/octet-stream");
  const allowed = ["image/jpeg", "image/jpg", "image/png", "video/mp4", "application/pdf"];
  if (!allowed.includes(mime.toLowerCase()) && !mime.startsWith("image/")) {
    throw new HttpError(400, "Use JPEG/PNG image, MP4 video, or PDF document");
  }
  const headerHandle = await cloudApi.uploadTemplateHeaderHandle(
    runtime.secrets.accessToken,
    wabaId,
    file.buffer,
    mime,
    file.originalname || "sample",
  );
  await logWhatsAppActivity("template.header_uploaded", actorId, { mime, fileName: file.originalname }, configId);
  return { headerHandle };
}
