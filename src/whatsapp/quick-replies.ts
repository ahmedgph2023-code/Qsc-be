import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappQuickReplies } from "../db/schema/whatsapp.js";
import { getConfigRow } from "./config.js";
import { HttpError } from "./errors.js";
import { logWhatsAppActivity } from "./activity.js";

function serialize(row: typeof whatsappQuickReplies.$inferSelect) {
  return {
    id: row.id,
    configId: row.configId,
    title: row.title,
    body: row.body,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listQuickReplies(configId: string) {
  await getConfigRow(configId);
  const rows = await db
    .select()
    .from(whatsappQuickReplies)
    .where(eq(whatsappQuickReplies.configId, configId))
    .orderBy(asc(whatsappQuickReplies.sortOrder), asc(whatsappQuickReplies.createdAt));
  return rows.map(serialize);
}

export async function createQuickReply(
  configId: string,
  actorId: string | null,
  input: { title?: string; body?: string },
) {
  await getConfigRow(configId);
  const title = String(input.title || "").trim();
  const body = String(input.body || "").trim();
  if (!title || !body) throw new HttpError(400, "Title and reply text are required");
  const [row] = await db
    .insert(whatsappQuickReplies)
    .values({ configId, title, body })
    .returning();
  await logWhatsAppActivity("quick_reply.created", actorId, { id: row.id, title }, configId);
  return serialize(row);
}

export async function updateQuickReply(
  configId: string,
  id: string,
  actorId: string | null,
  input: { title?: string; body?: string },
) {
  const [existing] = await db
    .select()
    .from(whatsappQuickReplies)
    .where(and(eq(whatsappQuickReplies.id, id), eq(whatsappQuickReplies.configId, configId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "Quick reply not found");
  const title = input.title != null ? String(input.title).trim() : existing.title;
  const body = input.body != null ? String(input.body).trim() : existing.body;
  if (!title || !body) throw new HttpError(400, "Title and reply text are required");
  const [row] = await db
    .update(whatsappQuickReplies)
    .set({ title, body, updatedAt: new Date() })
    .where(eq(whatsappQuickReplies.id, id))
    .returning();
  await logWhatsAppActivity("quick_reply.updated", actorId, { id }, configId);
  return serialize(row);
}

export async function deleteQuickReply(configId: string, id: string, actorId: string | null) {
  const [existing] = await db
    .select()
    .from(whatsappQuickReplies)
    .where(and(eq(whatsappQuickReplies.id, id), eq(whatsappQuickReplies.configId, configId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "Quick reply not found");
  await db.delete(whatsappQuickReplies).where(eq(whatsappQuickReplies.id, id));
  await logWhatsAppActivity("quick_reply.deleted", actorId, { id }, configId);
  return { ok: true };
}
