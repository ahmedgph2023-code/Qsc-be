import { Router } from "express";
import { param } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

router.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  try {
    let q = db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.occurredAt)).limit(200);
    const rows = await q;
    let filtered = rows;
    if (req.query.objectType) filtered = filtered.filter((r) => r.objectType === req.query.objectType);
    if (req.query.objectId) filtered = filtered.filter((r) => r.objectId === req.query.objectId);
    if (req.query.userId) filtered = filtered.filter((r) => r.userId === req.query.userId);
    res.json(filtered);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/health", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    const latestPrice = await db.select({ d: schema.stockPrices.date })
      .from(schema.stockPrices)
      .orderBy(desc(schema.stockPrices.date))
      .limit(1);
    res.json({
      dbOk: true,
      lastPriceDate: latestPrice[0]?.d ?? null,
      aiPolicy: "AI features are analysis-only and cannot trade, approve, or override compliance.",
    });
  } catch (err: any) {
    res.status(500).json({ dbOk: false, error: err.message });
  }
});

export default router;
