import { Router } from "express";
import { param } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { eq, desc } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit, writeAuditTx } from "../services/audit.js";
import { buildPortfolioSnapshot } from "../services/rebalance-engine.js";
import { runCompliance } from "../services/compliance-engine.js";
import { canTransitionRebalance, type RebalanceLockTarget } from "../services/rebalance-lock.js";
import { executeStockTrade, reverseStockTradeCash } from "../services/trade-cash.js";
import { assertTradeEligibility, formatEligibilityReasons } from "../services/mandate-rules.js";

const router = Router();
router.use(authMiddleware);

const tn = (v: unknown) => Number(v ?? 0);

router.get("/", async (req, res) => {
  try {
    let rows = await db.select().from(schema.rebalances).orderBy(desc(schema.rebalances.proposedAt));
    if (req.query.portfolioId) rows = rows.filter((r) => r.portfolioId === req.query.portfolioId);
    if (req.query.status) rows = rows.filter((r) => r.lockStatus === req.query.status);
    if (req.query.trigger) rows = rows.filter((r) => r.trigger === req.query.trigger);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const rows = await db.select().from(schema.rebalances).where(eq(schema.rebalances.id, param(req.params.id))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const trades = await db.select().from(schema.rebalanceProposedTrades)
      .where(eq(schema.rebalanceProposedTrades.rebalanceId, rows[0].id));
    const corrections = await db.select().from(schema.rebalanceCorrections)
      .where(eq(schema.rebalanceCorrections.rebalanceId, rows[0].id));
    res.json({ ...rows[0], proposedTrades: trades, corrections });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function transition(req: AuthRequest, res: any, to: RebalanceLockTarget) {
  try {
    const rows = await db.select().from(schema.rebalances).where(eq(schema.rebalances.id, param(req.params.id))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const rb = rows[0];
    if (rb.lockStatus === "final") { res.status(400).json({ error: "FINAL_LOCKED" }); return; }

    if (!canTransitionRebalance(rb.lockStatus, to)) {
      res.status(400).json({ error: `Cannot transition ${rb.lockStatus} → ${to}` });
      return;
    }

    if (to === "approved" && rb.portfolioId) {
      const target = (rb.targetAllocation as any)?.holdings || [];
      const compliance = await runCompliance({
        portfolioId: rb.portfolioId,
        targetWeights: target,
        rebalanceId: rb.id,
      });
      if (!compliance.passed) {
        res.status(400).json({ error: "COMPLIANCE_FAILED", checks: compliance.checks });
        return;
      }
    }

    // Execute proposed trades through the cash ledger + eligibility gate (AUD-C01).
    if (to === "executed") {
      if (!rb.portfolioId) {
        res.status(400).json({ error: "Rebalance has no portfolio" });
        return;
      }
      const trades = await db.select().from(schema.rebalanceProposedTrades)
        .where(eq(schema.rebalanceProposedTrades.rebalanceId, rb.id));
      const executedAt = new Date();
      const createdTxIds: string[] = [];
      try {
        for (const t of trades) {
          const side = t.side as "BUY" | "SELL";
          if (side !== "BUY" && side !== "SELL") {
            throw Object.assign(new Error(`Invalid proposed side ${t.side}`), { status: 400, code: "INVALID_SIDE", stockId: t.stockId });
          }
          const qty = tn(t.quantity);
          const price = tn(t.estimatedPrice);
          if (!(qty > 0)) continue;

          const eligibility = await assertTradeEligibility({
            portfolioId: rb.portfolioId,
            stockId: t.stockId,
            type: side,
          });
          if (!eligibility.ok) {
            throw Object.assign(
              new Error(eligibility.message || formatEligibilityReasons(eligibility.reasons || [])),
              {
                status: eligibility.status,
                code: eligibility.code || "ELIGIBILITY_FAILED",
                reasons: eligibility.reasons,
                stockId: t.stockId,
              },
            );
          }

          const result = await executeStockTrade({
            portfolioId: rb.portfolioId,
            stockId: t.stockId,
            type: side,
            quantity: qty,
            price: price > 0 ? price : null,
            timestamp: executedAt,
            notes: `Rebalance ${rb.rebalanceCode}`,
            createdBy: req.userId || null,
            rebalanceId: rb.id,
            skipPriceRange: true,
            forceClosingPrice: !(price > 0),
          });
          createdTxIds.push(result.transaction.id);
        }
      } catch (err: any) {
        for (const id of [...createdTxIds].reverse()) {
          try {
            await reverseStockTradeCash(id);
          } catch (revErr) {
            console.error("[rebalance] rollback failed for", id, revErr);
          }
        }
        res.status(err.status || 400).json({
          error: err.code || "TRADE_FAILED",
          message: err.message,
          stockId: err.stockId,
          rolledBack: createdTxIds.length,
        });
        return;
      }
    }

    const updated = await db.transaction(async (tx) => {
      const patch: Record<string, unknown> = {
        lockStatus: to,
        updatedAt: new Date(),
      };
      if (to === "approved") { patch.approvedAt = new Date(); patch.approvedBy = req.userId; }
      if (to === "executed") { patch.executedAt = new Date(); }
      if (to === "final" && rb.portfolioId) {
        patch.finalizedAt = new Date();
        patch.afterSnapshot = await buildPortfolioSnapshot(rb.portfolioId);
      }

      const [row] = await tx.update(schema.rebalances).set(patch as any).where(eq(schema.rebalances.id, rb.id)).returning();
      await writeAuditTx(tx, {
        userId: req.userId,
        action: to === "approved" ? "approve" : "status_change",
        objectType: "rebalance",
        objectId: rb.id,
        oldValue: { status: rb.lockStatus },
        newValue: { status: to },
        reason: req.body?.reason,
      });
      return row;
    });

    res.json(updated);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

router.post("/:id/approve", requireRole("approver", "admin"), (req, res) => transition(req as AuthRequest, res, "approved"));
router.post("/:id/execute", requireRole("pm", "admin"), (req, res) => transition(req as AuthRequest, res, "executed"));
router.post("/:id/finalize", requireRole("approver", "admin", "pm"), (req, res) => transition(req as AuthRequest, res, "final"));
router.post("/:id/cancel", requireRole("approver", "admin"), (req, res) => transition(req as AuthRequest, res, "cancelled"));

router.post("/:id/corrections", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const rows = await db.select().from(schema.rebalances).where(eq(schema.rebalances.id, param(req.params.id))).limit(1);
    if (!rows[0] || rows[0].lockStatus !== "final") {
      res.status(400).json({ error: "Corrections only allowed on final rebalances" });
      return;
    }
    const { fieldPath, oldValue, newValue, reason } = req.body;
    if (!fieldPath || !reason) { res.status(400).json({ error: "fieldPath and reason required" }); return; }
    const created = await db.transaction(async (tx) => {
      const [c] = await tx.insert(schema.rebalanceCorrections).values({
        rebalanceId: rows[0].id,
        fieldPath,
        oldValue,
        newValue,
        reason,
        correctedBy: req.userId,
      }).returning();
      await writeAuditTx(tx, {
        userId: req.userId, action: "correction", objectType: "rebalance", objectId: rows[0].id,
        oldValue, newValue, reason,
      });
      return c;
    });
    res.status(201).json(created);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
