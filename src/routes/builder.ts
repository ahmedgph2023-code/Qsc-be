import { Router } from "express";
import { param } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { eq, desc, asc, and } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { runCompliance } from "../services/compliance-engine.js";
import { proposeTrades, buildPortfolioSnapshot, nextRebalanceCode } from "../services/rebalance-engine.js";
import { syncIndexMembershipFlags } from "../services/index-membership.js";
import { evaluateSatelliteGate } from "../services/research-engine.js";
import { getSystemFlag } from "../services/system-config.js";
import { sql } from "drizzle-orm";

const router = Router();
router.use(authMiddleware);

// ── Models ─────────────────────────────────────────────────────────────────
router.get("/models", async (_req, res) => {
  try {
    const models = await db.select().from(schema.modelPortfolios).orderBy(schema.modelPortfolios.code);
    const result = [];
    for (const m of models) {
      const holdings = await db.select().from(schema.modelHoldings).where(eq(schema.modelHoldings.modelPortfolioId, m.id));
      result.push({ ...m, holdings });
    }
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/models/:id/holdings", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const holdings = req.body.holdings as { stockId: string; targetWeight: number; sleeve?: string }[];
    if (!Array.isArray(holdings)) { res.status(400).json({ error: "holdings array required" }); return; }
    await db.delete(schema.modelHoldings).where(eq(schema.modelHoldings.modelPortfolioId, param(req.params.id)));
    if (holdings.length) {
      await db.insert(schema.modelHoldings).values(
        holdings.map((h) => ({
          modelPortfolioId: param(req.params.id),
          stockId: h.stockId,
          targetWeight: String(h.targetWeight),
          sleeve: h.sleeve || "active",
        }))
      );
    }
    await db.update(schema.modelPortfolios).set({
      version: sql`${schema.modelPortfolios.version} + 1`,
      updatedAt: new Date(),
    }).where(eq(schema.modelPortfolios.id, param(req.params.id)));
    const saved = await db.select().from(schema.modelHoldings).where(eq(schema.modelHoldings.modelPortfolioId, param(req.params.id)));
    await writeAudit({
      userId: req.userId, action: "update", objectType: "model_portfolio", objectId: param(req.params.id), newValue: { holdings: saved },
    });
    res.json(saved);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Index reference ────────────────────────────────────────────────────────
router.get("/index-reference", async (req, res) => {
  try {
    const name = String(req.query.index || "QERI").toUpperCase();
    const indices = await db.select().from(schema.indices);
    const index = indices.find((i) => i.name.toUpperCase().includes(name));
    if (!index) { res.json({ index: null, constituents: [] }); return; }
    const constituents = await db.select().from(schema.indexConstituents)
      .where(eq(schema.indexConstituents.indexId, index.id))
      .orderBy(desc(schema.indexConstituents.effectiveDate));
    // latest effective date set
    const latestDate = constituents[0]?.effectiveDate;
    const latest = latestDate
      ? constituents.filter((c) => c.effectiveDate === latestDate)
      : [];
    const enriched = [];
    for (const c of latest) {
      const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.id, c.stockId)).limit(1);
      const prices = await db.select().from(schema.stockPrices)
        .where(eq(schema.stockPrices.stockId, c.stockId))
        .orderBy(desc(schema.stockPrices.date))
        .limit(1);
      enriched.push({
        ...c,
        ticker: stocks[0]?.ticker,
        companyName: stocks[0]?.companyName,
        sector: stocks[0]?.sector,
        shariahGroup: stocks[0]?.shariahGroup,
        price: prices[0] ? Number(prices[0].price) : null,
      });
    }
    res.json({ index, effectiveDate: latestDate, constituents: enriched });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/indices/:indexId/constituents", async (req, res) => {
  try {
    const indexId = param(req.params.indexId);
    const rows = await db
      .select({
        stockId: schema.indexConstituents.stockId,
        weight: schema.indexConstituents.weight,
        effectiveDate: schema.indexConstituents.effectiveDate,
        ticker: schema.stocks.ticker,
        companyName: schema.stocks.companyName,
        sector: schema.stocks.sector,
      })
      .from(schema.indexConstituents)
      .leftJoin(schema.stocks, eq(schema.stocks.id, schema.indexConstituents.stockId))
      .where(eq(schema.indexConstituents.indexId, indexId))
      .orderBy(desc(schema.indexConstituents.effectiveDate), asc(schema.stocks.ticker));

    const byDate = new Map<string, {
      effectiveDate: string;
      constituents: { stockId: string; ticker: string | null; companyName: string | null; sector: string | null; weight: number; weightPct: number }[];
      totalWeight: number;
      totalWeightPct: number;
    }>();

    for (const r of rows) {
      const date = String(r.effectiveDate).slice(0, 10);
      if (!byDate.has(date)) {
        byDate.set(date, { effectiveDate: date, constituents: [], totalWeight: 0, totalWeightPct: 0 });
      }
      const snap = byDate.get(date)!;
      const weight = Number(r.weight);
      snap.constituents.push({
        stockId: r.stockId,
        ticker: r.ticker,
        companyName: r.companyName,
        sector: r.sector,
        weight,
        weightPct: Math.round(weight * 1000000) / 10000,
      });
      snap.totalWeight += weight;
    }

    const snapshots = Array.from(byDate.values()).map((s) => ({
      ...s,
      totalWeight: Math.round(s.totalWeight * 1e8) / 1e8,
      totalWeightPct: Math.round(s.totalWeight * 1000000) / 10000,
    }));

    res.json({ snapshots });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put("/indices/:indexId/constituents", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const indexId = param(req.params.indexId);
    const { effectiveDate, constituents } = req.body as {
      effectiveDate: string;
      constituents: { stockId: string; weight: number }[];
    };
    if (!effectiveDate || !Array.isArray(constituents)) {
      res.status(400).json({ error: "effectiveDate and constituents required" });
      return;
    }

    const normalized = constituents
      .map((c) => ({
        stockId: c.stockId,
        weight: Number(c.weight) > 1 ? Number(c.weight) / 100 : Number(c.weight),
      }))
      .filter((c) => c.stockId && Number.isFinite(c.weight) && c.weight > 0);

    if (normalized.length === 0) {
      res.status(400).json({ error: "At least one constituent with weight > 0 is required" });
      return;
    }

    const total = normalized.reduce((s, c) => s + c.weight, 0);
    if (Math.abs(total - 1) > 0.0001) {
      res.status(400).json({
        error: `Total weight must equal 100% (got ${(total * 100).toFixed(4)}%)`,
      });
      return;
    }

    await db.delete(schema.indexConstituents).where(and(
      eq(schema.indexConstituents.indexId, indexId),
      eq(schema.indexConstituents.effectiveDate, effectiveDate),
    ));

    await db.insert(schema.indexConstituents).values(
      normalized.map((c) => ({
        indexId,
        stockId: c.stockId,
        weight: String(c.weight),
        effectiveDate,
      }))
    );

    const membership = await syncIndexMembershipFlags();
    res.json({ success: true, count: normalized.length, effectiveDate, totalWeight: 1, membership });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/indices/:indexId/constituents", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const indexId = param(req.params.indexId);
    const effectiveDate = typeof req.query.effectiveDate === "string" ? req.query.effectiveDate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      res.status(400).json({ error: "effectiveDate query param (YYYY-MM-DD) is required" });
      return;
    }
    const deleted = await db.delete(schema.indexConstituents).where(and(
      eq(schema.indexConstituents.indexId, indexId),
      eq(schema.indexConstituents.effectiveDate, effectiveDate),
    )).returning({ id: schema.indexConstituents.id });
    const membership = await syncIndexMembershipFlags();
    res.json({ success: true, effectiveDate, deleted: deleted.length, membership });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Builder sessions ───────────────────────────────────────────────────────
router.post("/sessions", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const { targetType, modelPortfolioId, portfolioId, mandateId, payload } = req.body;
    const [session] = await db.insert(schema.builderSessions).values({
      targetType,
      modelPortfolioId: modelPortfolioId || null,
      portfolioId: portfolioId || null,
      mandateId: mandateId || null,
      payload: payload || {},
      createdBy: req.userId,
    }).returning();
    res.status(201).json(session);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const rows = await db.select().from(schema.builderSessions).where(eq(schema.builderSessions.id, param(req.params.id))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch("/sessions/:id", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const [updated] = await db.update(schema.builderSessions).set({
      payload: req.body.payload ?? {},
      status: req.body.status || undefined,
      updatedAt: new Date(),
    }).where(eq(schema.builderSessions.id, param(req.params.id))).returning();
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/sessions/:id/review", requireRole("admin", "pm"), async (req, res) => {
  try {
    const rows = await db.select().from(schema.builderSessions).where(eq(schema.builderSessions.id, param(req.params.id))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const session = rows[0];
    const payload = (session.payload || {}) as { holdings?: { stockId: string; weight: number; sleeve?: string }[] };
    const holdings = payload.holdings || [];
    const sum = holdings.reduce((s, h) => s + Number(h.weight), 0);
    const validations: { code: string; ok: boolean; message: string }[] = [];
    validations.push({
      code: "WEIGHT_SUM",
      ok: Math.abs(sum - 1) < 0.0001 || Math.abs(sum - 100) < 0.01,
      message: `Weight sum = ${sum}`,
    });

    const satellite = holdings.filter((h) => h.sleeve === "satellite");
    const core = holdings.filter((h) => h.sleeve === "core");
    if (satellite.length) {
      validations.push({
        code: "SATELLITE_COUNT",
        ok: satellite.length >= 3 && satellite.length <= 5,
        message: `Satellite names: ${satellite.length} (need 3–5)`,
      });
    }

    const fiveLayer: Array<{ stockId: string; allowed: boolean; message: string; reasonCode?: string }> = [];
    for (const h of satellite) {
      const gate = await evaluateSatelliteGate(h.stockId);
      fiveLayer.push({
        stockId: h.stockId,
        allowed: gate.allowed,
        message: gate.message,
        reasonCode: gate.reasonCode,
      });
      validations.push({
        code: "FIVE_LAYER_SATELLITE",
        ok: gate.allowed,
        message: `${h.stockId}: ${gate.message}`,
      });
    }

    let compliance = { checks: [] as any[], passed: true };
    if (session.portfolioId) {
      const normalized = holdings.map((h) => ({
        stockId: h.stockId,
        weight: Number(h.weight) > 1 ? Number(h.weight) / 100 : Number(h.weight),
        sleeve: h.sleeve || null,
      }));
      compliance = await runCompliance({
        portfolioId: session.portfolioId,
        targetWeights: normalized,
        persist: true,
      });
    }

    await db.update(schema.builderSessions).set({ status: "reviewed", updatedAt: new Date() })
      .where(eq(schema.builderSessions.id, session.id));

    res.json({
      validations,
      compliance,
      fiveLayer,
      coreCount: core.length,
      satelliteCount: satellite.length,
      weightSum: sum,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/sessions/:id/propose-trades", requireRole("admin", "pm"), async (req, res) => {
  try {
    const rows = await db.select().from(schema.builderSessions).where(eq(schema.builderSessions.id, param(req.params.id))).limit(1);
    if (!rows[0]?.portfolioId) { res.status(400).json({ error: "Client session with portfolio required" }); return; }
    const payload = (rows[0].payload || {}) as { holdings?: { stockId: string; weight: number }[] };
    const targets = (payload.holdings || []).map((h) => ({
      stockId: h.stockId,
      weight: Number(h.weight) > 1 ? Number(h.weight) / 100 : Number(h.weight),
    }));
    const trades = await proposeTrades(rows[0].portfolioId, targets);
    res.json({ trades });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/sessions/:id/convert", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const rows = await db.select().from(schema.builderSessions).where(eq(schema.builderSessions.id, param(req.params.id))).limit(1);
    if (!rows[0]?.portfolioId) { res.status(400).json({ error: "Client portfolio session required" }); return; }
    const session = rows[0];
    const payload = (session.payload || {}) as { holdings?: { stockId: string; weight: number; sleeve?: string }[] };
    const holdings = payload.holdings || [];
    const targets = holdings.map((h) => ({
      stockId: h.stockId,
      weight: Number(h.weight) > 1 ? Number(h.weight) / 100 : Number(h.weight),
      sleeve: h.sleeve,
    }));

    const compliance = await runCompliance({
      portfolioId: session.portfolioId!,
      targetWeights: targets,
      persist: true,
    });
    if (!compliance.passed) {
      res.status(400).json({ error: "COMPLIANCE_FAILED", checks: compliance.checks });
      return;
    }

    const researchHard = await getSystemFlag("research_gate_hard_block", true);
    if (researchHard) {
      const satellite = holdings.filter((h) => h.sleeve === "satellite");
      const blocked = [];
      for (const h of satellite) {
        const gate = await evaluateSatelliteGate(h.stockId);
        if (!gate.allowed) {
          blocked.push({ stockId: h.stockId, reasonCode: gate.reasonCode, message: gate.message });
        }
      }
      if (blocked.length) {
        res.status(400).json({ error: "FIVE_LAYER_GATE_FAILED", blocked });
        return;
      }
    }

    const before = await buildPortfolioSnapshot(session.portfolioId!);
    const trades = await proposeTrades(session.portfolioId!, targets);
    const countRow = await db.select({ c: sql<number>`count(*)::int` }).from(schema.rebalances);
    const code = nextRebalanceCode((countRow[0]?.c ?? 0) + 1);

    const [rb] = await db.insert(schema.rebalances).values({
      rebalanceCode: code,
      portfolioId: session.portfolioId,
      modelPortfolioId: session.modelPortfolioId,
      trigger: (req.body.trigger as any) || "ad_hoc",
      lockStatus: "draft",
      preparedBy: req.userId,
      beforeSnapshot: before,
      targetAllocation: { holdings: targets },
      complianceSummary: { passed: compliance.passed, checks: compliance.checks },
      notes: req.body.notes || null,
    }).returning();

    if (trades.length) {
      await db.insert(schema.rebalanceProposedTrades).values(
        trades.map((t) => ({
          rebalanceId: rb.id,
          stockId: t.stockId,
          side: t.side,
          quantity: String(t.quantity),
          estimatedPrice: String(t.estimatedPrice),
          estimatedValue: String(t.estimatedValue),
          reason: t.reason,
          complianceResult: "pass" as const,
        }))
      );
    }

    await db.update(schema.builderSessions).set({ status: "converted", updatedAt: new Date() })
      .where(eq(schema.builderSessions.id, session.id));

    await writeAudit({
      userId: req.userId, action: "create", objectType: "rebalance", objectId: rb.id, newValue: rb,
    });

    res.status(201).json(rb);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
