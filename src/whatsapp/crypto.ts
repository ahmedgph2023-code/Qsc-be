import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { resolveJwtSecret } from "../lib/jwt-secret.js";

export type WhatsAppSecrets = {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
};

export function encryptionKey(): Buffer {
  const dedicated = process.env.META_WHATSAPP_ENCRYPTION_KEY?.trim();
  if (dedicated) {
    const key = Buffer.from(dedicated, "base64");
    if (key.length !== 32) {
      throw new Error("META_WHATSAPP_ENCRYPTION_KEY must decode to 32 bytes");
    }
    return key;
  }
  const jwtSecret = resolveJwtSecret();
  return createHash("sha256").update(`qsc:whatsapp-credentials:${jwtSecret}`).digest();
}

export function encryptSecrets(secrets: WhatsAppSecrets): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecrets(encoded: string): WhatsAppSecrets {
  const payload = Buffer.from(encoded, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
  ) as WhatsAppSecrets;
}

export function hashVerifyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyTokenMatches(plain: string, hash: string | null | undefined): boolean {
  if (!plain || !hash) return false;
  const a = Buffer.from(hashVerifyToken(plain), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyMetaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const hmac = createHmac("sha256", appSecret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
    .digest("hex");
  try {
    const a = Buffer.from(hmac, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `••••${value.slice(-4)}`;
}

/** Digits-only E.164-ish id used by Cloud API (no +). Qatar 8-digit local → 974. */
export function normalizeWaId(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = String(phone).trim().replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^[34567]\d{7}$/.test(digits)) digits = `974${digits}`;
  if (digits.startsWith("0")) return null;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

export const CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function bestMessageTimestamp(
  ...values: Array<Date | string | number | null | undefined>
): number {
  let best = 0;
  for (const value of values) {
    if (value == null || value === "") continue;
    let ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > 0 && ms < 1e11) ms *= 1000;
    if (ms < 1e12) continue;
    if (ms > best) best = ms;
  }
  return best;
}

export function isWithinCustomerCareWindow(
  lastInboundAt: Date | null | undefined,
  now = new Date(),
): boolean {
  const at = bestMessageTimestamp(lastInboundAt);
  if (!at) return false;
  return now.getTime() - at <= CUSTOMER_CARE_WINDOW_MS;
}
