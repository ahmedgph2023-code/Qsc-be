/**
 * Wassenger outbound WhatsApp API (client-supplied for report delivery).
 * Contract matches QSC sample:
 *   POST https://api.wassenger.com/v1/messages
 *   Authorization: Bearer <token>
 *   { phone, message, media?: { url } | { file } }
 * Prefer token/url from Settings delivery config; env is fallback only.
 */

export type WassengerSendInput = {
  phone: string;
  message: string;
  mediaUrl?: string | null;
  /** When set, upload PDF bytes to Wassenger /v1/files then send media.file. */
  pdf?: { buffer: Buffer; filename: string } | null;
  apiUrl?: string | null;
  apiToken?: string | null;
};

export type WassengerSendResult = {
  ok: boolean;
  note: string;
};

export type WassengerMessageBody = {
  phone: string;
  message: string;
  media?: { url: string } | { file: string };
};

export function normalizeWassengerPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  return `+${digits}`;
}

/** Build JSON body exactly as the client curl sample. */
export function buildWassengerMessageBody(input: {
  phone: string;
  message: string;
  mediaUrl?: string | null;
  mediaFileId?: string | null;
}): WassengerMessageBody {
  const body: WassengerMessageBody = {
    phone: normalizeWassengerPhone(input.phone),
    message: input.message,
  };
  const fileId = input.mediaFileId?.trim();
  if (fileId) {
    body.media = { file: fileId };
    return body;
  }
  const mediaUrl = input.mediaUrl?.trim();
  if (mediaUrl) {
    body.media = { url: mediaUrl };
  }
  return body;
}

function filesApiUrl(messagesUrl: string): string {
  const trimmed = messagesUrl.trim().replace(/\/+$/, "");
  if (/\/v1\/messages$/i.test(trimmed)) {
    return trimmed.replace(/\/v1\/messages$/i, "/v1/files");
  }
  return "https://api.wassenger.com/v1/files";
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Token: token,
  };
}

/** Upload PDF (or other) bytes to Wassenger file storage; returns file id. */
export async function uploadWassengerFile(input: {
  buffer: Buffer;
  filename: string;
  apiToken: string;
  filesUrl?: string | null;
}): Promise<{ ok: true; fileId: string } | { ok: false; note: string }> {
  const url = (input.filesUrl || "https://api.wassenger.com/v1/files").trim();
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([input.buffer], { type: "application/pdf" }),
      input.filename || "report.pdf",
    );
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(input.apiToken),
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, note: `Wassenger file upload HTTP ${res.status}: ${text.slice(0, 240)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, note: "Wassenger file upload returned non-JSON" };
    }
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const fileId = row && typeof row === "object" && "id" in row
      ? String((row as { id: unknown }).id ?? "")
      : "";
    if (!fileId) {
      return { ok: false, note: "Wassenger file upload missing file id" };
    }
    return { ok: true, fileId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, note: `Wassenger file upload failed: ${msg}` };
  }
}

export async function sendWassengerMessage(input: WassengerSendInput): Promise<WassengerSendResult> {
  const token = (input.apiToken || process.env.WASSENGER_API_TOKEN || "").trim();
  if (!token) {
    return { ok: false, note: "Wassenger API token not set" };
  }
  const url = (
    input.apiUrl
    || process.env.WASSENGER_API_URL
    || "https://api.wassenger.com/v1/messages"
  ).trim();
  const phone = normalizeWassengerPhone(input.phone);
  if (!phone.replace(/\D/g, "")) {
    return { ok: false, note: "Invalid phone number" };
  }

  let mediaFileId: string | null = null;
  if (input.pdf?.buffer?.length) {
    const uploaded = await uploadWassengerFile({
      buffer: input.pdf.buffer,
      filename: input.pdf.filename || "QSC-ClientReport.pdf",
      apiToken: token,
      filesUrl: filesApiUrl(url),
    });
    if (!uploaded.ok) return { ok: false, note: uploaded.note };
    mediaFileId = uploaded.fileId;
  }

  const mediaUrl = mediaFileId
    ? null
    : ((input.mediaUrl || process.env.WASSENGER_MEDIA_URL || "").trim() || null);

  const body = buildWassengerMessageBody({
    phone,
    message: input.message,
    mediaUrl,
    mediaFileId,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, note: `Wassenger HTTP ${res.status}: ${text.slice(0, 240)}` };
    }
    const mediaNote = body.media
      ? ("file" in body.media ? " (with PDF attachment)" : " (with PDF media.url)")
      : "";
    return { ok: true, note: `Wassenger message sent to ${phone}${mediaNote}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, note: `Wassenger failed: ${msg}` };
  }
}
