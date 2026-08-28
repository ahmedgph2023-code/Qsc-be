import { db, schema } from "../db/connection.js";

type AuditAction =
  | "create" | "update" | "delete" | "approve" | "reject"
  | "status_change" | "override" | "login" | "export" | "correction";

type AuditFields = {
  userId?: string | null;
  action: AuditAction;
  objectType: string;
  objectId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
};

type AuditTx = {
  insert: typeof db.insert;
};

async function insertAudit(executor: AuditTx, params: AuditFields) {
  await executor.insert(schema.auditLogs).values({
    userId: params.userId ?? null,
    action: params.action,
    objectType: params.objectType,
    objectId: params.objectId ?? null,
    oldValue: (params.oldValue as Record<string, unknown>) ?? null,
    newValue: (params.newValue as Record<string, unknown>) ?? null,
    reason: params.reason ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}

export async function writeAudit(params: AuditFields & {
  /** When true (default for money/IPS paths), failure propagates. Login may set false. */
  throwOnFailure?: boolean;
}) {
  const throwOnFailure = params.throwOnFailure !== false;
  try {
    await insertAudit(db, params);
  } catch (err) {
    console.error("[audit] failed to write", err);
    if (throwOnFailure) throw err;
  }
}

/** Insert audit row using the same Drizzle transaction as the mutation (FIN-02). */
export async function writeAuditTx(tx: AuditTx, params: AuditFields) {
  await insertAudit(tx, params);
}
