import { Router } from "express";
import { param } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { eq, desc, and } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { runCompliance, listRecentCompliance } from "../services/compliance-engine.js";
import { scanAllPortfoliosRisk, scanPortfolioRisk } from "../services/risk-engine.js";

const router = Router();
router.use(authMiddleware);

router.post("/run", requireRole("admin", "pm", "approver", "compliance"), async (req, res) => {
  try {
    const { portfolioId, targetWeights, timing } = req.body;
    if (!portfolioId) { res.status(400).json({ error: "portfolioId required" }); return; }
    const result = await runCompliance({ portfolioId, targetWeights, timing });
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/results", async (req, res) => {
  try {
    const rows = await listRecentCompliance(req.query.portfolioId as string | undefined);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/exceptions", async (req, res) => {
  try {
    let rows = await db.select().from(schema.complianceExceptions).orderBy(desc(schema.complianceExceptions.createdAt));
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/exceptions", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const { portfolioId, checkCode, reason, validUntil } = req.body;
    const [row] = await db.insert(schema.complianceExceptions).values({
      portfolioId, checkCode, reason, validUntil: validUntil || null, requestedBy: req.userId,
    }).returning();
    await writeAudit({
      userId: req.userId, action: "create", objectType: "compliance_exception", objectId: row.id, newValue: row,
    });
    res.status(201).json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/exceptions/:id/approve", requireRole("approver", "compliance", "admin"), async (req: AuthRequest, res) => {
  try {
    const [row] = await db.update(schema.complianceExceptions).set({
      status: "approved", approvedBy: req.userId, updatedAt: new Date(),
    }).where(eq(schema.complianceExceptions.id, param(req.params.id))).returning();
    await writeAudit({
      userId: req.userId, action: "approve", objectType: "compliance_exception", objectId: row.id,
      reason: req.body.reason,
    });
    res.json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/exceptions/:id/reject", requireRole("approver", "compliance", "admin"), async (req: AuthRequest, res) => {
  try {
    const [row] = await db.update(schema.complianceExceptions).set({
      status: "rejected", updatedAt: new Date(),
    }).where(eq(schema.complianceExceptions.id, param(req.params.id))).returning();
    await writeAudit({
      userId: req.userId, action: "reject", objectType: "compliance_exception", objectId: row.id,
      reason: req.body.reason,
    });
    res.json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Risk under /compliance router mount sibling - separate file better
export const riskRouter = Router();
riskRouter.use(authMiddleware);

riskRouter.get("/alerts", async (req, res) => {
  try {
    let rows = await db.select().from(schema.riskAlerts).orderBy(desc(schema.riskAlerts.openedAt));
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    if (req.query.portfolioId) rows = rows.filter((r) => r.portfolioId === req.query.portfolioId);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

riskRouter.post("/scan", requireRole("admin", "pm", "approver", "compliance"), async (req, res) => {
  try {
    if (req.body.portfolioId) {
      res.json(await scanPortfolioRisk(req.body.portfolioId));
    } else {
      res.json(await scanAllPortfoliosRisk());
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

riskRouter.post("/alerts/:id/resolve", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const [row] = await db.update(schema.riskAlerts).set({
      status: "resolved",
      resolvedAt: new Date(),
      resolutionNotes: req.body.notes || null,
    }).where(eq(schema.riskAlerts.id, param(req.params.id))).returning();
    await writeAudit({
      userId: req.userId, action: "status_change", objectType: "risk_alert", objectId: row.id, reason: req.body.notes,
    });
    res.json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

riskRouter.post("/alerts/:id/waive", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const [row] = await db.update(schema.riskAlerts).set({
      status: "waived",
      resolvedAt: new Date(),
      resolutionNotes: req.body.reason || "Waived",
    }).where(eq(schema.riskAlerts.id, param(req.params.id))).returning();
    await writeAudit({
      userId: req.userId, action: "override", objectType: "risk_alert", objectId: row.id, reason: req.body.reason,
    });
    res.json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

riskRouter.post("/alerts/:id/assign", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const ownerId = req.body.ownerId === undefined ? req.userId : req.body.ownerId;
    const [row] = await db.update(schema.riskAlerts).set({
      ownerId: ownerId || null,
    }).where(eq(schema.riskAlerts.id, param(req.params.id))).returning();
    await writeAudit({
      userId: req.userId, action: "update", objectType: "risk_alert", objectId: row.id,
      newValue: { ownerId: row.ownerId }, reason: req.body.reason || "Assigned",
    });
    res.json(row);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

riskRouter.get("/config", async (_req, res) => {
  try {
    res.json(await db.select().from(schema.ipsLimitConfig));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
