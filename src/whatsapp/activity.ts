import { eq, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsappActivity } from "../db/schema/whatsapp.js";

export async function logWhatsAppActivity(
  event: string,
  actorId: string | null,
  payload: Record<string, unknown> = {},
  configId?: string | null,
) {
  await db.insert(whatsappActivity).values({
    event,
    actorId,
    payload,
    configId: configId ?? null,
  });
}

export async function listWhatsAppActivity(configId: string, limit = 50) {
  const rows = await db
    .select()
    .from(whatsappActivity)
    .where(eq(whatsappActivity.configId, configId))
    .orderBy(desc(whatsappActivity.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    actorId: r.actorId,
    payload: r.payload,
    createdAt: r.createdAt,
  }));
}
