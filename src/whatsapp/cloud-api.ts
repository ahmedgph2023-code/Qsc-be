import { HttpError } from "./errors.js";

export type MetaGraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
  error_data?: { messaging_product?: string; details?: string };
};

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION?.trim() || "v21.0";

function baseUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}`;
}

function errText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function explainWhatsAppAccessError(
  metaMessage: string,
  ctx: { phoneNumberId?: string | null; wabaId?: string | null },
): string {
  const phone = ctx.phoneNumberId || "—";
  const waba = ctx.wabaId || "—";
  const base = metaMessage || "Meta Graph access failed";
  if (
    /#100\b/i.test(base) ||
    /invalid parameter/i.test(base) ||
    /does not exist/i.test(base) ||
    /already exists/i.test(base) ||
    /\(#\d+\)/.test(base)
  ) {
    return base;
  }
  return (
    `${base} Phone Number ID (${phone}) / WABA ID (${waba}): ensure the access token has ` +
    `whatsapp_business_management + whatsapp_business_messaging and is assigned to this WABA.`
  );
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  accessToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new HttpError(
      503,
      `Unable to reach Meta Graph API: ${error instanceof Error ? error.message : error}`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as T & { error?: MetaGraphError };
  if (!res.ok || json.error) {
    const err = json.error;
    const details =
      err?.error_data?.details || err?.error_user_msg || err?.error_user_title || "";
    const codePrefix = err?.code != null ? `(#${err.code}) ` : "";
    const message = err?.message || `Meta Graph API error (${res.status})`;
    const coded = message.startsWith("(#") ? message : `${codePrefix}${message}`;
    const fullMessage = details ? `${coded} — ${details}` : coded;
    throw new HttpError(400, fullMessage);
  }
  return json;
}

export async function validateCredentials(input: {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string | null;
}) {
  let phone: {
    id?: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    whatsapp_business_account?: { id?: string; name?: string };
  };
  try {
    phone = await request(
      "GET",
      `/${input.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,whatsapp_business_account{id,name}`,
      input.accessToken,
    );
  } catch (err) {
    throw new HttpError(
      400,
      explainWhatsAppAccessError(errText(err), {
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
      }),
    );
  }

  const resolvedFromPhone = phone.whatsapp_business_account?.id || null;
  let configuredWaba = String(input.wabaId || "").trim() || null;
  if (configuredWaba && configuredWaba === String(input.phoneNumberId).trim()) {
    configuredWaba = null;
  }

  let wabaOk: { id?: string; name?: string } | null = null;
  const wabaToCheck = configuredWaba || resolvedFromPhone;
  if (wabaToCheck) {
    try {
      wabaOk = await request("GET", `/${wabaToCheck}?fields=id,name`, input.accessToken);
    } catch (err) {
      if (resolvedFromPhone && configuredWaba && configuredWaba !== resolvedFromPhone) {
        wabaOk = await request("GET", `/${resolvedFromPhone}?fields=id,name`, input.accessToken);
      } else {
        throw new HttpError(
          400,
          explainWhatsAppAccessError(errText(err), {
            phoneNumberId: input.phoneNumberId,
            wabaId: wabaToCheck,
          }),
        );
      }
    }
  }

  const finalWabaId = wabaOk?.id || resolvedFromPhone || configuredWaba || null;
  if (finalWabaId) {
    try {
      await request(
        "GET",
        `/${finalWabaId}/message_templates?limit=1&fields=id,name`,
        input.accessToken,
      );
    } catch (err) {
      throw new HttpError(
        400,
        explainWhatsAppAccessError(errText(err), {
          phoneNumberId: input.phoneNumberId,
          wabaId: finalWabaId,
        }),
      );
    }
  }

  return {
    phoneNumberId: phone.id || input.phoneNumberId,
    displayPhoneNumber: phone.display_phone_number || null,
    verifiedName: phone.verified_name || null,
    qualityRating: phone.quality_rating || null,
    wabaId: finalWabaId,
    wabaName: wabaOk?.name || phone.whatsapp_business_account?.name || null,
  };
}

export async function listMessageTemplates(accessToken: string, wabaId: string) {
  const data = await request<{ data?: Array<Record<string, unknown>> }>(
    "GET",
    `/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`,
    accessToken,
  );
  return (data.data || []).map((t) => ({
    name: String(t.name || ""),
    language: String(t.language || ""),
    status: String(t.status || ""),
    category: String(t.category || ""),
    components: (Array.isArray(t.components) ? t.components : []) as unknown[],
    id: t.id,
    qualityScore: t.quality_score || null,
  }));
}

async function sendMessage(
  accessToken: string,
  phoneNumberId: string,
  body: Record<string, unknown>,
) {
  const result = await request<{
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id?: string; input?: string }>;
  }>("POST", `/${phoneNumberId}/messages`, accessToken, body);
  const wamid = result.messages?.[0]?.id;
  if (!wamid) throw new HttpError(400, "Meta Cloud API did not return a message id");
  return {
    wamid,
    waId: result.contacts?.[0]?.wa_id || body.to,
    raw: result,
  };
}

export async function sendText(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
) {
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: true, body: text },
  });
}

export async function sendTemplate(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  language: string,
  components?: unknown[],
) {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: language || "en" },
  };
  if (components?.length) template.components = components;
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template,
  });
}

export async function markAsRead(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
) {
  return request("POST", `/${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

export async function getMediaUrl(accessToken: string, mediaId: string) {
  return request<{ url?: string; mime_type?: string; file_size?: number }>(
    "GET",
    `/${mediaId}`,
    accessToken,
  );
}

export async function downloadMedia(accessToken: string, mediaUrl: string): Promise<Buffer> {
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new HttpError(503, `Failed to download Meta media (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadMedia(
  accessToken: string,
  phoneNumberId: string,
  file: Buffer,
  mimeType: string,
  fileName: string,
) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([file], { type: mimeType }), fileName);

  const url = `${baseUrl()}/${phoneNumberId}/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: MetaGraphError };
  if (!res.ok || json.error || !json.id) {
    const message = json.error?.message || "Meta media upload failed";
    throw new HttpError(400, message);
  }
  return { mediaId: json.id };
}

export async function sendImageById(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  mediaId: string,
  caption?: string,
) {
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId, ...(caption ? { caption } : {}) },
  });
}

export async function sendDocumentById(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  mediaId: string,
  filename?: string,
  caption?: string,
) {
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      id: mediaId,
      ...(filename ? { filename } : {}),
      ...(caption ? { caption } : {}),
    },
  });
}

export async function sendAudioById(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  mediaId: string,
) {
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "audio",
    audio: { id: mediaId },
  });
}

export async function sendVideoById(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  mediaId: string,
  caption?: string,
) {
  return sendMessage(accessToken, phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "video",
    video: { id: mediaId, ...(caption ? { caption } : {}) },
  });
}

export async function createMessageTemplate(
  accessToken: string,
  wabaId: string,
  input: { name: string; language: string; category: string; components: unknown[] },
) {
  return request<Record<string, unknown>>("POST", `/${wabaId}/message_templates`, accessToken, {
    name: input.name,
    language: input.language,
    category: String(input.category || "UTILITY").toUpperCase(),
    allow_category_change: true,
    parameter_format: "positional",
    components: input.components,
  });
}

export async function editMessageTemplate(
  accessToken: string,
  templateId: string,
  components: unknown[],
) {
  const id = String(templateId || "").trim();
  if (!id) throw new HttpError(400, "Template id is required to edit");
  return request<Record<string, unknown>>("POST", `/${id}`, accessToken, { components });
}

export async function deleteMessageTemplate(
  accessToken: string,
  wabaId: string,
  input: { name?: string; hsmId?: string },
) {
  const name = String(input.name || "").trim();
  if (!name) throw new HttpError(400, "Template name is required to delete");
  const params = new URLSearchParams();
  params.set("name", name);
  const hsmId = String(input.hsmId || "").trim();
  if (hsmId) params.set("hsm_id", hsmId);
  return request<{ success?: boolean }>(
    "DELETE",
    `/${wabaId}/message_templates?${params.toString()}`,
    accessToken,
  );
}

export async function listMessageTemplateLibrary(
  accessToken: string,
  options?: { search?: string; language?: string; limit?: number },
) {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(options?.limit || 40, 1), 100)));
  if (options?.search?.trim()) params.set("search", options.search.trim());
  if (options?.language?.trim()) params.set("language", options.language.trim());
  const data = await request<{ data?: Array<Record<string, unknown>> }>(
    "GET",
    `/message_template_library?${params.toString()}`,
    accessToken,
  );
  return (data.data || []).map((t) => ({
    libraryTemplateName: String(t.name || ""),
    name: String(t.name || ""),
    language: String(t.language || ""),
    category: String(t.category || "UTILITY"),
    topic: t.topic || null,
    usecase: t.usecase || null,
    industry: t.industry || [],
    body: String(t.body || t.body_text || ""),
    bodyParams: t.body_params || t.body_param_types || [],
    header: t.header || t.header_text || null,
    footer: t.footer || t.footer_text || null,
    buttons: t.buttons || [],
    raw: t,
  }));
}

function defaultLibrarySite() {
  const fromEnv =
    process.env.PUBLIC_WEB_URL?.trim() || process.env.META_WHATSAPP_LIBRARY_BUTTON_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const api = process.env.META_WHATSAPP_PUBLIC_API_URL?.trim() || process.env.PUBLIC_API_URL?.trim();
  if (api) {
    try {
      return new URL(api).origin;
    } catch {
      /* ignore */
    }
  }
  return "https://example.com";
}

function buildLibraryTemplateButtonInputs(
  buttons: unknown[],
  defaults?: { url?: string; phone?: string },
) {
  const list = Array.isArray(buttons) ? buttons : [];
  const site = String(defaults?.url || defaultLibrarySite()).replace(/\/$/, "");
  const httpsSite = /^https:\/\//i.test(site) ? site : `https://${site.replace(/^https?:\/\//i, "")}`;
  let phone = String(defaults?.phone || "").replace(/[^\d+]/g, "");
  if (phone && !phone.startsWith("+")) phone = `+${phone}`;
  if (!phone) phone = "+97444000000";

  const inputs: Record<string, unknown>[] = [];
  for (const btn of list) {
    const rec = (btn || {}) as Record<string, unknown>;
    const type = String(rec.type || rec.button_type || "").toUpperCase();
    if (type === "URL" || type === "VISIT_WEBSITE") {
      const fromBtn = String(rec.url || rec.example || "").trim();
      const base =
        fromBtn && /^https:\/\//i.test(fromBtn)
          ? fromBtn.replace(/\{\{.*?\}\}/g, "{{1}}")
          : `${httpsSite}/{{1}}`;
      const withVar = /\{\{/.test(base) ? base : `${base.replace(/\/$/, "")}/{{1}}`;
      inputs.push({
        type: "URL",
        url: {
          base_url: withVar,
          url_suffix_example: withVar.replace(/\{\{\s*\d+\s*\}\}/g, "demo"),
        },
      });
    } else if (type === "PHONE_NUMBER" || type === "CALL" || type === "CALL_PHONE_NUMBER") {
      const fromBtn = String(rec.phone_number || rec.phone || "").replace(/[^\d+]/g, "");
      const value = fromBtn ? (fromBtn.startsWith("+") ? fromBtn : `+${fromBtn}`) : phone;
      inputs.push({ type: "PHONE_NUMBER", phone_number: value });
    } else if (type === "OTP") {
      inputs.push({
        type: "OTP",
        otp_type: String(rec.otp_type || "COPY_CODE").toUpperCase(),
        zero_tap_terms_accepted: true,
      });
    }
  }
  return inputs;
}

export async function createMessageTemplateFromLibrary(
  accessToken: string,
  wabaId: string,
  input: {
    name: string;
    language?: string;
    category?: string;
    libraryTemplateName: string;
    buttons?: unknown[];
    buttonUrl?: string;
    buttonPhone?: string;
  },
) {
  const payload: Record<string, unknown> = {
    name: String(input.name || "").trim(),
    language: String(input.language || "en_US").trim(),
    category: String(input.category || "UTILITY").toUpperCase(),
    library_template_name: String(input.libraryTemplateName || "").trim(),
  };
  const buttonInputs = buildLibraryTemplateButtonInputs(input.buttons || [], {
    url: input.buttonUrl,
    phone: input.buttonPhone,
  });
  if (buttonInputs.length) payload.library_template_button_inputs = buttonInputs;
  return request<Record<string, unknown>>("POST", `/${wabaId}/message_templates`, accessToken, payload);
}

export async function uploadTemplateHeaderHandle(
  accessToken: string,
  wabaId: string,
  file: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  const sessionPath =
    `/${wabaId}/uploads` +
    `?file_length=${file.length}` +
    `&file_type=${encodeURIComponent(mimeType)}` +
    `&file_name=${encodeURIComponent(fileName || "sample")}`;
  const session = await request<{ id?: string }>("POST", sessionPath, accessToken);
  const uploadId = String(session?.id || "").trim();
  if (!uploadId) throw new HttpError(400, "Meta upload session did not return an id");

  const url = `${baseUrl()}/${uploadId.replace(/^\//, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: "0",
      "Content-Type": mimeType,
    },
    body: new Uint8Array(file),
  });
  const json = (await res.json().catch(() => ({}))) as { h?: string; error?: MetaGraphError };
  const handle = json?.h;
  if (!res.ok || json.error || !handle) {
    throw new HttpError(400, json.error?.message || "Meta template media upload failed");
  }
  return String(handle);
}

export async function listSubscribedApps(accessToken: string, wabaId: string) {
  const data = await request<{ data?: Array<Record<string, unknown>> }>(
    "GET",
    `/${wabaId}/subscribed_apps`,
    accessToken,
  );
  return data.data || [];
}

export async function subscribeWabaApp(accessToken: string, wabaId: string) {
  return request<Record<string, unknown>>("POST", `/${wabaId}/subscribed_apps`, accessToken, {});
}

export async function getBusinessProfile(accessToken: string, phoneNumberId: string) {
  const data = await request<{ data?: Array<Record<string, unknown>> }>(
    "GET",
    `/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
    accessToken,
  );
  return data.data?.[0] || null;
}

export { GRAPH_VERSION };
