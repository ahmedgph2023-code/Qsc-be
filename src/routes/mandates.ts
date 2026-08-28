import { Router } from "express";
import { param } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { eq, desc } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit, writeAuditTx } from "../services/audit.js";
import {
  findBenchmarkIndex,
  findModelByMandate,
  type RiskProfile,
  type ShariahPreference,
} from "../services/mandate-rules.js";

const router = Router();
router.use(authMiddleware);

router.get("/customer/:customerId", async (req, res) => {
  try {
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Mandate not found" }); return; }
    const restrictions = await db.select().from(schema.mandateRestrictions).where(eq(schema.mandateRestrictions.mandateId, rows[0].id));
    const history = await db.select().from(schema.mandateStatusHistory)
      .where(eq(schema.mandateStatusHistory.mandateId, rows[0].id))
      .orderBy(desc(schema.mandateStatusHistory.changedAt));
    res.json({ ...rows[0], restrictions, history });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/customer/:customerId", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const { shariahPreference, riskProfile, notes, contractStart, contractEnd, initialValue } = req.body;
    if (!shariahPreference || !riskProfile) {
      res.status(400).json({ error: "shariahPreference and riskProfile required" });
      return;
    }
    const pref = shariahPreference as ShariahPreference;
    if (pref !== "fully_shariah" && pref !== "unrestricted") {
      res.status(400).json({ error: "shariahPreference must be fully_shariah or unrestricted" });
      return;
    }
    const risk = riskProfile as RiskProfile;
    const benchmark = await findBenchmarkIndex(pref);
    const model = await findModelByMandate(pref, risk);
    const existing = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);

    const payload = {
      shariahPreference: pref,
      riskProfile: risk,
      benchmarkIndexId: benchmark?.id ?? null,
      modelPortfolioId: model?.id ?? null,
      notes: notes ?? null,
      contractStart: contractStart ?? null,
      contractEnd: contractEnd ?? null,
      initialValue: initialValue != null ? String(initialValue) : null,
      updatedAt: new Date(),
    };

    let mandate;
    if (existing[0]) {
      const wasApproved = existing[0].approvalStatus === "approved";
      const [updated] = await db.update(schema.mandates).set({
        ...payload,
        approvalStatus: wasApproved ? "amended" : existing[0].approvalStatus,
      }).where(eq(schema.mandates.id, existing[0].id)).returning();
      if (wasApproved) {
        await db.insert(schema.mandateStatusHistory).values({
          mandateId: updated.id,
          fromStatus: "approved",
          toStatus: "amended",
          changedBy: req.userId,
          reason: "Mandate fields updated",
        });
      }
      mandate = updated;
      await writeAudit({
        userId: req.userId, action: "update", objectType: "mandate", objectId: mandate.id,
        oldValue: existing[0], newValue: mandate,
      });
    } else {
      const [created] = await db.insert(schema.mandates).values({
        customerId: param(req.params.customerId),
        ...payload,
        approvalStatus: "pending",
      }).returning();
      await db.insert(schema.mandateStatusHistory).values({
        mandateId: created.id, fromStatus: null, toStatus: "pending", changedBy: req.userId, reason: "Created",
      });
      mandate = created;
      await writeAudit({
        userId: req.userId, action: "create", objectType: "mandate", objectId: mandate.id, newValue: mandate,
      });
    }

    // Sync portfolio benchmark + model
    await db.update(schema.portfolios).set({
      benchmarkIndexId: mandate.benchmarkIndexId,
      modelPortfolioId: mandate.modelPortfolioId,
      updatedAt: new Date(),
    }).where(eq(schema.portfolios.customerId, param(req.params.customerId)));

    res.json(mandate);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/customer/:customerId/approve", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Mandate not found" }); return; }
    if (rows[0].approvalStatus === "closed") {
      res.status(400).json({ error: "Closed mandates cannot be approved" });
      return;
    }
    const from = rows[0].approvalStatus;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.mandates).set({
        approvalStatus: "approved",
        approvedBy: req.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.mandates.id, rows[0].id)).returning();
      await tx.insert(schema.mandateStatusHistory).values({
        mandateId: row.id, fromStatus: from, toStatus: "approved",
        changedBy: req.userId, reason: "Approved",
      });
      await writeAuditTx(tx, {
        userId: req.userId, action: "approve", objectType: "mandate", objectId: row.id,
        oldValue: { status: from }, newValue: { status: "approved" },
      });
      return row;
    });
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/customer/:customerId/reject", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "A rejection reason is required" });
      return;
    }
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Mandate not found" }); return; }
    if (rows[0].approvalStatus === "closed") {
      res.status(400).json({ error: "Closed mandates cannot be rejected" });
      return;
    }
    if (rows[0].approvalStatus === "approved") {
      res.status(400).json({ error: "Approved mandates must be closed, not rejected" });
      return;
    }
    const from = rows[0].approvalStatus;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.mandates).set({
        approvalStatus: "rejected",
        updatedAt: new Date(),
      }).where(eq(schema.mandates.id, rows[0].id)).returning();
      await tx.insert(schema.mandateStatusHistory).values({
        mandateId: row.id, fromStatus: from, toStatus: "rejected",
        changedBy: req.userId, reason,
      });
      await writeAuditTx(tx, {
        userId: req.userId, action: "reject", objectType: "mandate", objectId: row.id,
        oldValue: { status: from }, newValue: { status: "rejected" }, reason,
      });
      return row;
    });
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/customer/:customerId/close", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "A close reason is required" });
      return;
    }
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Mandate not found" }); return; }
    if (rows[0].approvalStatus === "closed") {
      res.status(400).json({ error: "Mandate is already closed" });
      return;
    }
    const from = rows[0].approvalStatus;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.mandates).set({
        approvalStatus: "closed", updatedAt: new Date(),
      }).where(eq(schema.mandates.id, rows[0].id)).returning();
      await tx.insert(schema.mandateStatusHistory).values({
        mandateId: row.id, fromStatus: from, toStatus: "closed",
        changedBy: req.userId, reason,
      });
      await writeAuditTx(tx, {
        userId: req.userId, action: "status_change", objectType: "mandate", objectId: row.id,
        oldValue: { status: from }, newValue: { status: "closed" }, reason,
      });
      return row;
    });
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/customer/:customerId/restrictions", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, param(req.params.customerId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Mandate not found" }); return; }
    const { restrictionType, stockId, sector, description } = req.body;
    const [created] = await db.insert(schema.mandateRestrictions).values({
      mandateId: rows[0].id,
      restrictionType,
      stockId: stockId || null,
      sector: sector || null,
      description: description || null,
    }).returning();
    await writeAudit({
      userId: req.userId, action: "create", objectType: "mandate_restriction", objectId: created.id, newValue: created,
    });
    res.status(201).json(created);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/restrictions/:id", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    await db.delete(schema.mandateRestrictions).where(eq(schema.mandateRestrictions.id, param(req.params.id)));
    await writeAudit({
      userId: req.userId, action: "delete", objectType: "mandate_restriction", objectId: param(req.params.id),
    });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
