import { createRequire } from "node:module";
import type {
  ClientReportDeliveryConfig,
  ClientReportEmailDelivery,
  ClientReportWassengerDelivery,
} from "../db/schema/client-reports.js";
import { DEFAULT_CLIENT_REPORT_DELIVERY } from "../db/schema/client-reports.js";
import { sendMediaMessage, sendTextMessage, sendTemplateMessage } from "../whatsapp/messaging.js";
import { db } from "../db/connection.js";
import { whatsappConfig } from "../db/schema/whatsapp.js";
import { eq } from "drizzle-orm";
import { sendLinkDeviceText } from "./link-device-session.js";
import { sendWassengerMessage } from "./wassenger-client.js";
import type { ClientReportPdfFile } from "./client-report-pdf.js";

const require = createRequire(import.meta.url);

type ReportPayload = {
  title: string;
  generatedAt: string;
  asOf: string;
  from: string;
  to: string;
  client: { id: number; name: string; email: string | null; phone?: string | null };
  sections: Record<string, unknown>;
  mediaUrl?: string | null;
};

export type ReportDeliveryOptions = {
  /** Generated report PDF — attached to email and uploaded for Wassenger. */
  pdf?: ClientReportPdfFile | null;
};

export type DeliveryChannelResult = {
  channel: "email" | "link_device" | "meta_whatsapp" | "wassenger";
  delivered: boolean;
  note: string;
};

export type DeliverySummary = {
  results: DeliveryChannelResult[];
  anyDelivered: boolean;
  summary: string;
};

/** Public shape returned to the dashboard (secrets redacted). */
export type PublicClientReportDeliveryConfig = {
  email: Omit<ClientReportEmailDelivery, "smtpPassword"> & {
    smtpPassword: "";
    smtpPasswordSet: boolean;
  };
  linkDevice: ClientReportDeliveryConfig["linkDevice"];
  metaWhatsapp: ClientReportDeliveryConfig["metaWhatsapp"];
  wassenger: Omit<ClientReportWassengerDelivery, "apiToken"> & {
    apiToken: "";
    apiTokenSet: boolean;
  };
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function mergeEmail(raw: Partial<ClientReportEmailDelivery> | undefined): ClientReportEmailDelivery {
  const base = DEFAULT_CLIENT_REPORT_DELIVERY.email;
  return {
    enabled: Boolean(raw?.enabled ?? base.enabled),
    smtpHost: str(raw?.smtpHost ?? base.smtpHost).trim(),
    smtpPort: Number(raw?.smtpPort ?? base.smtpPort) || 587,
    smtpUser: str(raw?.smtpUser ?? base.smtpUser).trim(),
    smtpFrom: str(raw?.smtpFrom ?? base.smtpFrom).trim(),
    smtpSecure: Boolean(raw?.smtpSecure ?? base.smtpSecure),
    smtpPassword: str(raw?.smtpPassword ?? base.smtpPassword),
  };
}

function mergeWassenger(raw: Partial<ClientReportWassengerDelivery> | undefined): ClientReportWassengerDelivery {
  const base = DEFAULT_CLIENT_REPORT_DELIVERY.wassenger;
  return {
    enabled: Boolean(raw?.enabled ?? base.enabled),
    apiUrl: str(raw?.apiUrl ?? base.apiUrl).trim() || base.apiUrl,
    apiToken: str(raw?.apiToken ?? base.apiToken).trim(),
  };
}

export function normalizeDeliveryConfig(raw: unknown): ClientReportDeliveryConfig {
  const base = DEFAULT_CLIENT_REPORT_DELIVERY;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ClientReportDeliveryConfig>;
  return {
    email: mergeEmail(r.email),
    linkDevice: { ...base.linkDevice, ...(r.linkDevice ?? {}) },
    metaWhatsapp: { ...base.metaWhatsapp, ...(r.metaWhatsapp ?? {}) },
    wassenger: mergeWassenger(r.wassenger),
  };
}

/** Keep previous secrets when the UI sends blank password/token fields. */
export function mergeDeliveryConfigUpdate(
  existingRaw: unknown,
  incomingRaw: unknown,
): ClientReportDeliveryConfig {
  const existing = normalizeDeliveryConfig(existingRaw);
  const incoming = normalizeDeliveryConfig(incomingRaw);
  const nextPassword = incoming.email.smtpPassword.trim();
  const nextToken = incoming.wassenger.apiToken.trim();
  return {
    ...incoming,
    email: {
      ...incoming.email,
      smtpPassword: nextPassword || existing.email.smtpPassword,
    },
    wassenger: {
      ...incoming.wassenger,
      apiToken: nextToken || existing.wassenger.apiToken,
    },
  };
}

export function publicDeliveryConfig(raw: unknown): PublicClientReportDeliveryConfig {
  const cfg = normalizeDeliveryConfig(raw);
  return {
    email: {
      enabled: cfg.email.enabled,
      smtpHost: cfg.email.smtpHost,
      smtpPort: cfg.email.smtpPort,
      smtpUser: cfg.email.smtpUser,
      smtpFrom: cfg.email.smtpFrom,
      smtpSecure: cfg.email.smtpSecure,
      smtpPassword: "",
      smtpPasswordSet: Boolean(cfg.email.smtpPassword.trim() || process.env.SMTP_PASSWORD?.trim() || process.env.SMTP_PASS?.trim()),
    },
    linkDevice: cfg.linkDevice,
    metaWhatsapp: cfg.metaWhatsapp,
    wassenger: {
      enabled: cfg.wassenger.enabled,
      apiUrl: cfg.wassenger.apiUrl,
      apiToken: "",
      apiTokenSet: Boolean(cfg.wassenger.apiToken.trim() || process.env.WASSENGER_API_TOKEN?.trim()),
    },
  };
}

function redactDeliveryForAudit(cfg: ClientReportDeliveryConfig) {
  return {
    ...cfg,
    email: { ...cfg.email, smtpPassword: cfg.email.smtpPassword ? "[set]" : "" },
    wassenger: { ...cfg.wassenger, apiToken: cfg.wassenger.apiToken ? "[set]" : "" },
  };
}

function resolveSmtpPassword(cfg: ClientReportEmailDelivery): string {
  return cfg.smtpPassword.trim()
    || process.env.SMTP_PASSWORD?.trim()
    || process.env.SMTP_PASS?.trim()
    || "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatReportSms(payload: ReportPayload, hasPdf: boolean): string {
  const perf = payload.sections.performance as {
    nav?: number;
    netPl?: number;
  } | null | undefined;
  const navLine = perf?.nav != null ? `NAV: QAR ${Number(perf.nav).toLocaleString("en")}` : "";
  const plLine = perf?.netPl != null ? `P&L: QAR ${Number(perf.netPl).toLocaleString("en")}` : "";
  const lines = [
    "QSC Portfolio Report",
    payload.client.name,
    `As of ${payload.asOf}`,
    navLine,
    plLine,
    hasPdf ? "Full report attached as PDF." : "",
    `Generated ${new Date(payload.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} AST`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function deliverEmail(
  cfg: ClientReportEmailDelivery,
  payload: ReportPayload,
  toEmail: string | null,
  pdf?: ClientReportPdfFile | null,
): Promise<DeliveryChannelResult> {
  if (!cfg.enabled) {
    return { channel: "email", delivered: false, note: "Email channel disabled" };
  }
  if (!toEmail) {
    return { channel: "email", delivered: false, note: "No recipient email for client" };
  }
  const host = cfg.smtpHost.trim() || process.env.SMTP_HOST?.trim() || "";
  const port = cfg.smtpPort || Number(process.env.SMTP_PORT || 587) || 587;
  const user = cfg.smtpUser.trim() || process.env.SMTP_USER?.trim() || "";
  const from = cfg.smtpFrom.trim() || process.env.SMTP_FROM?.trim() || user;
  const password = resolveSmtpPassword(cfg);
  if (!host) {
    return {
      channel: "email",
      delivered: false,
      note: "SMTP host missing — set it in Settings → Client Reports → Email",
    };
  }
  if (!password && !process.env.SMTP_NO_AUTH) {
    return { channel: "email", delivered: false, note: "SMTP password missing — save it in Email settings" };
  }

  try {
    // nodemailer is CJS; createRequire is reliable under tsx/ESM on Windows
    const nodemailer = require("nodemailer") as typeof import("nodemailer");
    const createTransport = nodemailer.createTransport
      ?? (nodemailer as { default?: typeof nodemailer }).default?.createTransport;
    if (!createTransport) {
      return { channel: "email", delivered: false, note: "Email failed: nodemailer createTransport unavailable" };
    }
    // TLS mode follows the port — ignore smtpSecure for 587 (Office365 STARTTLS).
    // secure:true on 587 → OpenSSL "wrong version number".
    const secure = port === 465;
    const transporter = createTransport({
      host,
      port,
      secure,
      requireTLS: port === 587 || (!secure && Boolean(cfg.smtpSecure)),
      tls: {
        minVersion: "TLSv1.2" as const,
        servername: host,
      },
      auth: password ? { user, pass: password } : undefined,
    });
    const hasPdf = Boolean(pdf?.buffer?.length);
    const textBody = [
      payload.title,
      `Client: ${payload.client.name}`,
      `As of: ${payload.asOf}`,
      `Period: ${payload.from} – ${payload.to}`,
      "",
      hasPdf
        ? "Please find the full client report attached as a PDF."
        : "This automated report was generated by QSC IPMS (PDF attachment unavailable).",
      "Generated by QSC IPMS.",
    ].join("\n");
    const htmlBody = [
      `<p><strong>${escapeHtml(payload.title)}</strong></p>`,
      `<p>Client: ${escapeHtml(payload.client.name)}<br/>`,
      `As of: ${escapeHtml(payload.asOf)}<br/>`,
      `Period: ${escapeHtml(payload.from)} – ${escapeHtml(payload.to)}</p>`,
      hasPdf
        ? "<p>Please find the full client report attached as a PDF.</p>"
        : "<p>This automated report was generated by QSC IPMS (PDF attachment unavailable).</p>",
      "<p style=\"color:#657491;font-size:12px\">Generated by QSC IPMS.</p>",
    ].join("");
    await transporter.sendMail({
      from,
      to: toEmail,
      subject: payload.title,
      text: textBody,
      html: htmlBody,
      attachments: hasPdf && pdf
        ? [{
            filename: pdf.filename,
            content: pdf.buffer,
            contentType: pdf.contentType,
          }]
        : undefined,
    });
    return {
      channel: "email",
      delivered: true,
      note: hasPdf ? `Email with PDF sent to ${toEmail}` : `Email sent to ${toEmail} (no PDF)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { channel: "email", delivered: false, note: `Email failed: ${msg}` };
  }
}

async function deliverLinkDevice(
  cfg: ClientReportDeliveryConfig["linkDevice"],
  payload: ReportPayload,
  phone: string | null,
  pdf?: ClientReportPdfFile | null,
): Promise<DeliveryChannelResult> {
  if (!cfg.enabled) {
    return { channel: "link_device", delivered: false, note: "Link Device WhatsApp disabled" };
  }
  if (cfg.status !== "connected") {
    return {
      channel: "link_device",
      delivered: false,
      note: "Link Device not connected — open Link Device settings and scan QR",
    };
  }
  if (!phone) {
    return { channel: "link_device", delivered: false, note: "No phone number for client" };
  }
  try {
    await sendLinkDeviceText(phone, formatReportSms(payload, Boolean(pdf?.buffer?.length)));
    return { channel: "link_device", delivered: true, note: `Link Device WhatsApp sent to ${phone}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { channel: "link_device", delivered: false, note: `Link Device failed: ${msg}` };
  }
}

async function deliverWassenger(
  cfg: ClientReportWassengerDelivery,
  payload: ReportPayload,
  phone: string | null,
  pdf?: ClientReportPdfFile | null,
): Promise<DeliveryChannelResult> {
  if (!cfg.enabled) {
    return { channel: "wassenger", delivered: false, note: "Wassenger WhatsApp disabled" };
  }
  const token = cfg.apiToken.trim() || process.env.WASSENGER_API_TOKEN?.trim() || "";
  if (!token) {
    return { channel: "wassenger", delivered: false, note: "Wassenger API token missing — save it in Settings" };
  }
  if (!phone) {
    return { channel: "wassenger", delivered: false, note: "No phone number for client" };
  }
  const hasPdf = Boolean(pdf?.buffer?.length);
  const result = await sendWassengerMessage({
    phone,
    message: formatReportSms(payload, hasPdf),
    mediaUrl: hasPdf ? null : (payload.mediaUrl ?? null),
    pdf: hasPdf && pdf ? { buffer: pdf.buffer, filename: pdf.filename } : null,
    apiUrl: cfg.apiUrl,
    apiToken: token,
  });
  return { channel: "wassenger", delivered: result.ok, note: result.note };
}

async function deliverMetaWhatsapp(
  cfg: ClientReportDeliveryConfig["metaWhatsapp"],
  payload: ReportPayload,
  phone: string | null,
  actorId: string | null,
  pdf?: ClientReportPdfFile | null,
): Promise<DeliveryChannelResult> {
  if (!cfg.enabled) {
    return { channel: "meta_whatsapp", delivered: false, note: "Meta WhatsApp disabled" };
  }
  if (!cfg.configId) {
    return { channel: "meta_whatsapp", delivered: false, note: "No Meta WhatsApp number selected" };
  }
  if (!phone) {
    return { channel: "meta_whatsapp", delivered: false, note: "No phone number for client" };
  }

  const [waRow] = await db.select().from(whatsappConfig).where(eq(whatsappConfig.id, cfg.configId)).limit(1);
  if (!waRow?.enabled || waRow.connectionStatus !== "connected") {
    return { channel: "meta_whatsapp", delivered: false, note: "Meta WhatsApp account not connected" };
  }

  const hasPdf = Boolean(pdf?.buffer?.length);
  const text = formatReportSms(payload, hasPdf);
  try {
    // Prefer sending the PDF as a WhatsApp document when available.
    if (hasPdf && pdf) {
      await sendMediaMessage(cfg.configId, actorId, {
        phone,
        displayName: payload.client.name,
        caption: text,
        mimeType: pdf.contentType || "application/pdf",
        fileName: pdf.filename,
        buffer: pdf.buffer,
      });
      return { channel: "meta_whatsapp", delivered: true, note: `WhatsApp PDF sent to ${phone}` };
    }
    if (cfg.templateName) {
      await sendTemplateMessage(cfg.configId, actorId, {
        phone,
        displayName: payload.client.name,
        templateName: cfg.templateName,
        language: "en",
      });
      return { channel: "meta_whatsapp", delivered: true, note: `WhatsApp template sent to ${phone}` };
    }
    await sendTextMessage(cfg.configId, actorId, {
      phone,
      displayName: payload.client.name,
      text,
    });
    return { channel: "meta_whatsapp", delivered: true, note: `WhatsApp message sent to ${phone}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cfg.templateName && hasPdf) {
      // If PDF send fails due to WhatsApp policy (outside customer care window),
      // fallback to template-only delivery when configured.
      try {
        await sendTemplateMessage(cfg.configId, actorId, {
          phone,
          displayName: payload.client.name,
          templateName: cfg.templateName,
          language: "en",
        });
        return {
          channel: "meta_whatsapp",
          delivered: true,
          note: `WhatsApp PDF send blocked — template sent to ${phone}`,
        };
      } catch {
        // fall through to default failure below
      }
    }

    if (!cfg.templateName && /customer care|24.?hour|template/i.test(msg)) {
      return {
        channel: "meta_whatsapp",
        delivered: false,
        note: "Outside 24h window — configure a Meta template name in delivery settings",
      };
    }
    return { channel: "meta_whatsapp", delivered: false, note: `WhatsApp failed: ${msg}` };
  }
}

export async function deliverClientReport(
  delivery: ClientReportDeliveryConfig,
  payload: ReportPayload,
  contacts: { email: string | null; phone: string | null },
  actorId?: string | null,
  options?: ReportDeliveryOptions,
): Promise<DeliverySummary> {
  const cfg = normalizeDeliveryConfig(delivery);
  const pdf = options?.pdf ?? null;
  const tasks: Array<Promise<DeliveryChannelResult>> = [];

  // Only attempt channels that are turned on — skip Off channels entirely.
  if (cfg.email.enabled) {
    tasks.push(deliverEmail(cfg.email, payload, contacts.email, pdf));
  }
  // Link Device is hidden from Client Reports UI — do not attempt it here.
  if (cfg.wassenger.enabled) {
    tasks.push(deliverWassenger(cfg.wassenger, payload, contacts.phone, pdf));
  }
  if (cfg.metaWhatsapp.enabled) {
    tasks.push(deliverMetaWhatsapp(cfg.metaWhatsapp, payload, contacts.phone, actorId ?? null, pdf));
  }

  if (tasks.length === 0) {
    return {
      results: [],
      anyDelivered: false,
      summary: "No delivery channels enabled — turn on Email, Wassenger, or Meta WhatsApp",
    };
  }

  const results = await Promise.all(tasks);
  const anyDelivered = results.some((r) => r.delivered);
  const summary = results.map((r) => `${r.channel}: ${r.note}`).join(" · ");
  return { results, anyDelivered, summary };
}

export type DeliveryChannelStatus = {
  email: PublicClientReportDeliveryConfig["email"] & { ready: boolean; configured: boolean };
  linkDevice: ClientReportDeliveryConfig["linkDevice"] & { ready: boolean };
  metaWhatsapp: ClientReportDeliveryConfig["metaWhatsapp"] & {
    ready: boolean;
    accountLabel: string | null;
    connectionStatus: string | null;
  };
  wassenger: PublicClientReportDeliveryConfig["wassenger"] & {
    ready: boolean;
    configured: boolean;
  };
};

export async function getDeliveryChannelStatus(
  delivery: ClientReportDeliveryConfig | PublicClientReportDeliveryConfig | unknown,
): Promise<DeliveryChannelStatus> {
  const cfg = normalizeDeliveryConfig(delivery);
  const pub = publicDeliveryConfig(cfg);
  const smtpHost = cfg.email.smtpHost.trim() || process.env.SMTP_HOST?.trim() || "";
  const smtpPassword = resolveSmtpPassword(cfg.email);
  const emailConfigured = Boolean(smtpHost);
  const emailReady = cfg.email.enabled && emailConfigured && Boolean(smtpPassword || process.env.SMTP_NO_AUTH);

  let accountLabel: string | null = null;
  let connectionStatus: string | null = null;
  if (cfg.metaWhatsapp.configId) {
    const [row] = await db.select().from(whatsappConfig).where(eq(whatsappConfig.id, cfg.metaWhatsapp.configId)).limit(1);
    accountLabel = row?.label ?? row?.displayPhoneNumber ?? null;
    connectionStatus = row?.connectionStatus ?? null;
  }
  const metaReady = cfg.metaWhatsapp.enabled
    && Boolean(cfg.metaWhatsapp.configId)
    && connectionStatus === "connected";

  const linkReady = cfg.linkDevice.enabled && cfg.linkDevice.status === "connected";
  const wassengerToken = cfg.wassenger.apiToken.trim() || process.env.WASSENGER_API_TOKEN?.trim() || "";
  const wassengerConfigured = Boolean(wassengerToken);
  const wassengerReady = cfg.wassenger.enabled && wassengerConfigured;

  return {
    email: {
      ...pub.email,
      smtpHost: smtpHost || pub.email.smtpHost,
      configured: emailConfigured,
      ready: emailReady,
    },
    linkDevice: {
      ...cfg.linkDevice,
      ready: linkReady,
    },
    metaWhatsapp: {
      ...cfg.metaWhatsapp,
      accountLabel,
      connectionStatus,
      ready: metaReady,
    },
    wassenger: {
      ...pub.wassenger,
      configured: wassengerConfigured,
      ready: wassengerReady,
    },
  };
}

export { redactDeliveryForAudit };
