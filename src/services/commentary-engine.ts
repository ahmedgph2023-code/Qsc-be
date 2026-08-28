import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { runAiAssistant } from "./ai-assistant.js";
import { writeAudit } from "./audit.js";

export async function generateCommentaryDraft(params: {
  kind: string;
  periodLabel?: string;
  portfolioId?: string;
  reportReleaseId?: string;
  userId?: string;
}) {
  const ai = await runAiAssistant({
    promptType: "commentary_draft",
    portfolioId: params.portfolioId,
    objectType: params.reportReleaseId ? "report_release" : "commentary",
    objectId: params.reportReleaseId,
    extra: `Report kind: ${params.kind}. Period: ${params.periodLabel ?? "n/a"}.`,
    userId: params.userId,
  });

  const [row] = await db.insert(schema.commentaryDrafts).values({
    reportReleaseId: params.reportReleaseId ?? null,
    kind: params.kind,
    periodLabel: params.periodLabel ?? null,
    portfolioId: params.portfolioId ?? null,
    body: ai.draft,
    status: "draft",
    aiLogId: ai.logId,
    createdBy: params.userId ?? null,
  }).returning();

  await writeAudit({
    userId: params.userId,
    action: "create",
    objectType: "commentary_draft",
    objectId: row.id,
    newValue: { kind: params.kind, status: "draft" },
  });

  return { draft: row, ai };
}

export async function listCommentaryDrafts() {
  return db.select().from(schema.commentaryDrafts)
    .orderBy(desc(schema.commentaryDrafts.createdAt))
    .limit(200);
}

export async function reviewCommentary(params: {
  id: string;
  status: "accepted" | "rejected" | "edited" | "released";
  body?: string;
  userId?: string;
}) {
  const [existing] = await db.select().from(schema.commentaryDrafts)
    .where(eq(schema.commentaryDrafts.id, params.id)).limit(1);
  if (!existing) throw Object.assign(new Error("Draft not found"), { status: 404 });

  if (params.status === "released" && existing.status !== "accepted" && existing.status !== "edited") {
    throw Object.assign(
      new Error("Commentary must be human-accepted (or edited) before release with a report"),
      { status: 400, code: "COMMENTARY_NOT_ACCEPTED" },
    );
  }

  const [row] = await db.update(schema.commentaryDrafts).set({
    status: params.status,
    body: params.body ?? existing.body,
    reviewedBy: params.userId ?? null,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.commentaryDrafts.id, params.id)).returning();

  if (existing.aiLogId && (params.status === "accepted" || params.status === "rejected")) {
    await db.update(schema.aiGovernanceLogs).set({
      accepted: params.status === "accepted",
    }).where(eq(schema.aiGovernanceLogs.id, existing.aiLogId));
  }

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "commentary_draft",
    objectId: row.id,
    newValue: { status: params.status },
  });

  return row;
}
