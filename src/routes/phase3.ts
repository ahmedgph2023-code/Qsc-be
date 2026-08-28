import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { db, schema } from "../db/connection.js";
import {
  approveLayerException,
  createShariaEsgReview,
  evaluateSatelliteGate,
  getResearchLayers,
  getScoreConfig,
  listApprovedList,
  listStockScores,
  listStrategies,
  requestLayerException,
  setApprovedListStatus,
  transitionStrategy,
  upsertResearchLayer,
  upsertStrategy,
} from "../services/research-engine.js";
import { getMarketOverview, getStockAnalytics, runScreener } from "../services/market-research.js";
import type { ApprovedListStatus, ResearchLayer } from "../db/schema/phase3.js";

function paramId(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

export const marketsRouter = Router();
marketsRouter.use(authMiddleware);

marketsRouter.get("/overview", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  try {
    res.json(await getMarketOverview());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Overview failed" });
  }
});

export const screenerRouter = Router();
screenerRouter.use(authMiddleware);

screenerRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  try {
    const q = req.query;
    const result = await runScreener({
      sector: typeof q.sector === "string" ? q.sector : undefined,
      shariahGroup: typeof q.shariahGroup === "string" ? q.shariahGroup : undefined,
      regulatoryStatus: typeof q.regulatoryStatus === "string" ? q.regulatoryStatus : undefined,
      search: typeof q.search === "string" ? q.search : undefined,
      minAdtv: q.minAdtv != null ? Number(q.minAdtv) : undefined,
      illiquid: q.illiquid === "true" ? true : q.illiquid === "false" ? false : undefined,
      qeriMember: q.qeriMember === "true" ? true : undefined,
      dsmMember: q.dsmMember === "true" ? true : undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Screener failed" });
  }
});

export const researchRouter = Router();
researchRouter.use(authMiddleware);

researchRouter.get("/approved-list", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ data: await listApprovedList(status) });
});

researchRouter.put("/approved-list/:stockId", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const status = req.body?.status as ApprovedListStatus;
    if (!status) {
      res.status(400).json({ error: "status required" });
      return;
    }
    const row = await setApprovedListStatus({
      stockId: paramId(req.params.stockId),
      status,
      notes: req.body?.notes,
      userId: req.adminId,
    });
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

researchRouter.get("/companies/:stockId", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  try {
    const stockId = paramId(req.params.stockId);
    const stocks = await db.select().from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (!stocks[0]) {
      res.status(404).json({ error: "Stock not found" });
      return;
    }
    const layers = await getResearchLayers(stockId);
    const gate = await evaluateSatelliteGate(stockId);
    const approved = await db.select().from(schema.stockApprovedList)
      .where(eq(schema.stockApprovedList.stockId, stockId)).limit(1);
    const reviews = await db.select().from(schema.shariaEsgReviews)
      .where(eq(schema.shariaEsgReviews.stockId, stockId))
      .orderBy(desc(schema.shariaEsgReviews.createdAt))
      .limit(10);
    res.json({
      stock: stocks[0],
      approvedList: approved[0] ?? { status: "watchlist" },
      layers,
      satelliteGate: gate,
      shariaEsgReviews: reviews,
      note: "AI/Gemini remains analysis-only and cannot approve research.",
    });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

researchRouter.put("/companies/:stockId/layers/:layer", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const row = await upsertResearchLayer({
      stockId: paramId(req.params.stockId),
      layer: paramId(req.params.layer) as ResearchLayer,
      status: req.body?.status,
      notes: req.body?.notes,
      analystName: req.body?.analystName,
      assessedAt: req.body?.assessedAt,
      evidenceUrl: req.body?.evidenceUrl,
      userId: req.adminId,
    });
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Layer update failed" });
  }
});

researchRouter.get("/companies/:stockId/satellite-gate", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  res.json(await evaluateSatelliteGate(paramId(req.params.stockId)));
});

researchRouter.post("/companies/:stockId/exceptions", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const reason = String(req.body?.reason || "");
    if (!reason) {
      res.status(400).json({ error: "reason required" });
      return;
    }
    const row = await requestLayerException({
      stockId: paramId(req.params.stockId),
      reason,
      userId: req.adminId,
    });
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Exception failed" });
  }
});

researchRouter.post("/exceptions/:id/approve", requireRole("admin", "approver"), async (req: AuthRequest, res) => {
  try {
    res.json(await approveLayerException(paramId(req.params.id), req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Approve failed" });
  }
});

researchRouter.get("/analytics/:stockId", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  try {
    const days = req.query.days != null ? Number(req.query.days) : 120;
    res.json(await getStockAnalytics(paramId(req.params.stockId), days));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Analytics failed" });
  }
});

researchRouter.get("/sharia-esg", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  const data = await db.select({
    id: schema.shariaEsgReviews.id,
    stockId: schema.shariaEsgReviews.stockId,
    shariahGroup: schema.shariaEsgReviews.shariahGroup,
    reviewDate: schema.shariaEsgReviews.reviewDate,
    reviewerName: schema.shariaEsgReviews.reviewerName,
    esgScore: schema.shariaEsgReviews.esgScore,
    syncToStock: schema.shariaEsgReviews.syncToStock,
    createdAt: schema.shariaEsgReviews.createdAt,
    ticker: schema.stocks.ticker,
    companyName: schema.stocks.companyName,
  })
    .from(schema.shariaEsgReviews)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.shariaEsgReviews.stockId))
    .orderBy(desc(schema.shariaEsgReviews.createdAt))
    .limit(200);
  res.json({ data, esgNote: "ESG scores UNKNOWN unless provided by QSC — do not fabricate." });
});

researchRouter.post("/sharia-esg", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    if (!req.body?.stockId) {
      res.status(400).json({ error: "stockId required" });
      return;
    }
    const row = await createShariaEsgReview({ ...req.body, userId: req.adminId });
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Review failed" });
  }
});

researchRouter.get("/strategies", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  res.json({ data: await listStrategies() });
});

researchRouter.post("/strategies", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const row = await upsertStrategy({ ...req.body, userId: req.adminId });
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Strategy failed" });
  }
});

researchRouter.post("/strategies/:id/transition", requireRole("admin", "approver"), async (req: AuthRequest, res) => {
  try {
    const status = req.body?.status as "draft" | "pending_ic" | "approved" | "retired";
    res.json(await transitionStrategy(paramId(req.params.id), status, req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Transition failed" });
  }
});

researchRouter.get("/scores", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  res.json(await listStockScores());
});

researchRouter.get("/score-config", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  res.json(await getScoreConfig());
});
