import fs from "fs";
import path from "path";
import qrcode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { db } from "../db/connection.js";
import * as schema from "../db/schema/index.js";
import { DEFAULT_CLIENT_REPORT_DELIVERY } from "../db/schema/client-reports.js";
import { normalizeDeliveryConfig } from "./client-report-delivery.js";
import { eq } from "drizzle-orm";

export const DEFAULT_LINK_DEVICE_LABEL = "QSC Reports Desk";

type LinkStatus = "disconnected" | "connecting" | "qr_pending" | "connected" | "error";

type LinkSessionSnapshot = {
  status: LinkStatus;
  qrDataUrl: string | null;
  sessionLabel: string;
  phoneNumber: string | null;
  error: string | null;
  updatedAt: string;
};

const AUTH_DIR = path.resolve(process.cwd(), ".data", "wa-link-device");

let socket: WASocket | null = null;
let starting = false;
let qrDataUrl: string | null = null;
let status: LinkStatus = "disconnected";
let phoneNumber: string | null = null;
let lastError: string | null = null;
let sessionLabel = DEFAULT_LINK_DEVICE_LABEL;
let generation = 0;

function snapshot(): LinkSessionSnapshot {
  return {
    status,
    qrDataUrl: status === "qr_pending" || status === "connecting" ? qrDataUrl : null,
    sessionLabel,
    phoneNumber,
    error: lastError,
    updatedAt: new Date().toISOString(),
  };
}

async function persistLinkDeviceStatus(next: {
  enabled?: boolean;
  status: "disconnected" | "pending" | "connected";
  sessionLabel?: string | null;
}) {
  const [row] = await db.select().from(schema.clientReportGlobalSettings)
    .where(eq(schema.clientReportGlobalSettings.id, 1)).limit(1);
  const current = normalizeDeliveryConfig(row?.deliveryConfig ?? DEFAULT_CLIENT_REPORT_DELIVERY);
  const deliveryConfig = {
    ...current,
    linkDevice: {
      ...current.linkDevice,
      enabled: next.enabled ?? current.linkDevice.enabled,
      status: next.status,
      sessionLabel: next.sessionLabel !== undefined
        ? next.sessionLabel
        : (current.linkDevice.sessionLabel || DEFAULT_LINK_DEVICE_LABEL),
    },
  };
  if (row) {
    await db.update(schema.clientReportGlobalSettings).set({
      deliveryConfig,
      updatedAt: new Date(),
    }).where(eq(schema.clientReportGlobalSettings.id, 1));
  }
}

async function stopSocket() {
  const current = socket;
  socket = null;
  if (!current) return;
  try {
    current.end(undefined);
  } catch {
    /* ignore */
  }
}

export function getLinkDeviceSession(): LinkSessionSnapshot {
  return snapshot();
}

export async function disconnectLinkDeviceSession() {
  generation += 1;
  starting = false;
  qrDataUrl = null;
  phoneNumber = null;
  lastError = null;
  status = "disconnected";
  await stopSocket();
  await persistLinkDeviceStatus({ status: "disconnected" });
  return snapshot();
}

export async function startLinkDeviceSession(label?: string | null) {
  sessionLabel = (label || "").trim() || DEFAULT_LINK_DEVICE_LABEL;
  if (status === "connected" && socket) {
    return snapshot();
  }
  if (starting && (status === "connecting" || status === "qr_pending")) {
    return snapshot();
  }

  starting = true;
  generation += 1;
  const gen = generation;
  qrDataUrl = null;
  phoneNumber = null;
  lastError = null;
  status = "connecting";
  await persistLinkDeviceStatus({
    enabled: true,
    status: "pending",
    sessionLabel,
  });

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await stopSocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      browser: Browsers.ubuntu("Chrome"),
    });
    socket = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
      if (gen !== generation) return;
      if (update.qr) {
        try {
          qrDataUrl = await qrcode.toDataURL(String(update.qr), { margin: 1, width: 320 });
        } catch {
          qrDataUrl = null;
          lastError = "Failed to render QR image";
        }
        status = "qr_pending";
        await persistLinkDeviceStatus({ status: "pending", sessionLabel });
      }

      if (update.connection === "open") {
        const fullId = String(sock.user?.id || "");
        phoneNumber = fullId.split(":")[0] || null;
        qrDataUrl = null;
        lastError = null;
        status = "connected";
        starting = false;
        await persistLinkDeviceStatus({ enabled: true, status: "connected", sessionLabel });
        return;
      }

      if (update.connection === "close") {
        const code = Number((update.lastDisconnect as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode || 0);
        if (code === DisconnectReason.loggedOut) {
          status = "disconnected";
          lastError = "WhatsApp logged out this linked device. Scan the QR again.";
          qrDataUrl = null;
          phoneNumber = null;
          starting = false;
          socket = null;
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          await persistLinkDeviceStatus({ status: "disconnected", sessionLabel });
          return;
        }
        if (status !== "connected") {
          status = "error";
          lastError = "Connection closed before link completed. Try generating a new QR.";
          starting = false;
          socket = null;
          await persistLinkDeviceStatus({ status: "disconnected", sessionLabel });
        }
      }
    });

    return snapshot();
  } catch (err) {
    starting = false;
    status = "error";
    lastError = err instanceof Error ? err.message : String(err);
    await persistLinkDeviceStatus({ status: "disconnected", sessionLabel });
    return snapshot();
  }
}

export async function sendLinkDeviceText(phone: string, text: string) {
  if (status !== "connected" || !socket) {
    throw Object.assign(new Error("Link Device WhatsApp is not connected"), { status: 400 });
  }
  const digits = phone.replace(/\D/g, "");
  if (!digits) throw Object.assign(new Error("Invalid phone number"), { status: 400 });
  const jid = `${digits}@s.whatsapp.net`;
  await socket.sendMessage(jid, { text });
  return { ok: true };
}
