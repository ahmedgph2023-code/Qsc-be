import { Router } from "express";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { simulateTrade } from "../services/trade-simulator.js";
import {
  createBlockGroup, createOrder, fillBlockProRata, listOrders, recordFill, transitionOrder,
} from "../services/oms-engine.js";
import { db, schema } from "../db/connection.js";
import { desc, eq } from "drizzle-orm";
import { getDashboardMetrics, getPortfolioHoldings } from "../services/calculations.js";
import { writeAudit } from "../services/audit.js";

function paramId(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

export const simulatorRouter = Router();
simulatorRouter.use(authMiddleware);

simulatorRouter.post("/run", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const { portfolioId, legs } = req.body ?? {};
    if (!portfolioId || !Array.isArray(legs)) {
      res.status(400).json({ error: "portfolioId and legs[] required" });
      return;
    }
    const result = await simulateTrade(portfolioId, legs);
    res.json(result);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Simulation failed" });
  }
});

export const ordersRouter = Router();
ordersRouter.use(authMiddleware);

ordersRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  const data = await listOrders({
    portfolioId: typeof req.query.portfolioId === "string" ? req.query.portfolioId : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
  });
  res.json({ data });
});

ordersRouter.post("/", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const row = await createOrder({ ...req.body, createdBy: req.adminId });
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

ordersRouter.post("/:id/transition", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const row = await transitionOrder(paramId(req.params.id), req.body?.status, req.adminId);
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Transition failed" });
  }
});

ordersRouter.post("/:id/fills", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const result = await recordFill({
      orderId: paramId(req.params.id),
      fillQty: Number(req.body?.fillQty),
      fillPrice: Number(req.body?.fillPrice),
      commission: req.body?.commission != null ? Number(req.body.commission) : 0,
      notes: req.body?.notes,
      createdBy: req.adminId,
      skipPriceRange: req.body?.skipPriceRange !== false,
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Fill failed" });
  }
});

ordersRouter.post("/blocks", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const block = await createBlockGroup({ ...req.body, createdBy: req.adminId });
    res.status(201).json(block);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Block failed" });
  }
});

ordersRouter.post("/blocks/:id/fill", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const result = await fillBlockProRata({
      blockGroupId: paramId(req.params.id),
      fillQty: Number(req.body?.fillQty),
      fillPrice: Number(req.body?.fillPrice),
      createdBy: req.adminId,
    });
    res.json(result);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Block fill failed" });
  }
});

export const reportsRouter = Router();
reportsRouter.use(authMiddleware);

reportsRouter.get("/releases", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  const data = await db.select().from(schema.reportReleases).orderBy(desc(schema.reportReleases.createdAt));
  res.json({ data });
});

reportsRouter.post("/releases", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  const kind = req.body?.kind as "client_monthly" | "aum_monthly" | "ic_quarterly";
  const periodLabel = String(req.body?.periodLabel || "");
  if (!kind || !periodLabel) {
    res.status(400).json({ error: "kind and periodLabel required" });
    return;
  }

  const latestRecon = await db.select().from(schema.reconciliationRuns).orderBy(desc(schema.reconciliationRuns.createdAt)).limit(1);
  const recon = latestRecon[0];
  const reconOk = recon && (recon.status === "cleared" || recon.status === "explained");

  let payload: Record<string, unknown> = { periodLabel };
  if (kind === "aum_monthly" || kind === "ic_quarterly") {
    payload = { ...payload, dashboard: await getDashboardMetrics() };
  }
  if (kind === "client_monthly" && req.body?.portfolioId) {
    const holdings = await getPortfolioHoldings(req.body.portfolioId);
    payload = { ...payload, portfolioId: req.body.portfolioId, holdings };
  }

  const status = reconOk ? "draft" : "blocked";
  const [row] = await db.insert(schema.reportReleases).values({
    kind,
    periodLabel,
    portfolioId: req.body?.portfolioId ?? null,
    status,
    payload,
    reconRunId: recon?.id ?? null,
    createdBy: req.adminId ?? null,
  }).returning();

  await writeAudit({
    userId: req.adminId,
    action: "create",
    objectType: "report_release",
    objectId: row.id,
    newValue: row,
    reason: reconOk ? null : "Blocked until reconciliation cleared/explained",
  });
  res.status(201).json(row);
});

reportsRouter.post("/releases/:id/release", requireRole("admin", "approver"), async (req: AuthRequest, res) => {
  const [row] = await db.select().from(schema.reportReleases).where(eq(schema.reportReleases.id, paramId(req.params.id))).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.status === "blocked") {
    res.status(400).json({ error: "Report blocked until reconciliation is cleared or explained" });
    return;
  }
  const [updated] = await db.update(schema.reportReleases).set({
    status: "released",
    releasedBy: req.adminId ?? null,
    releasedAt: new Date(),
  }).where(eq(schema.reportReleases.id, row.id)).returning();
  await writeAudit({
    userId: req.adminId,
    action: "approve",
    objectType: "report_release",
    objectId: row.id,
    newValue: updated,
  });
  res.json(updated);
});

export const reconciliationRouter = Router();
reconciliationRouter.use(authMiddleware);

reconciliationRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  const data = await db.select().from(schema.reconciliationRuns).orderBy(desc(schema.reconciliationRuns.createdAt));
  res.json({ data });
});

reconciliationRouter.post("/run", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  const asOf = String(req.body?.asOf || new Date().toISOString().slice(0, 10));
  const portfolios = await db.select().from(schema.portfolios);
  let holdingsDiffCount = 0;
  const sample: Array<{ portfolioId: string; cash: number; holdings: number }> = [];
  for (const p of portfolios.slice(0, 50)) {
    const holdings = await getPortfolioHoldings(p.id, asOf);
    const cash = Number(p.cashBalance ?? 0);
    sample.push({ portfolioId: p.id, cash, holdings: holdings.length });
    // Placeholder broker vs system: flag if cash cache is NaN (extend later with broker file)
    if (!Number.isFinite(cash)) holdingsDiffCount += 1;
  }
  const [row] = await db.insert(schema.reconciliationRuns).values({
    asOf,
    status: "open",
    cashDiff: "0",
    holdingsDiffCount,
    notes: req.body?.notes ?? "System self-check run (broker file compare TBD)",
    snapshot: { sampleCount: sample.length, sample },
    createdBy: req.adminId ?? null,
  }).returning();
  res.status(201).json(row);
});

reconciliationRouter.post("/:id/resolve", requireRole("admin", "approver"), async (req: AuthRequest, res) => {
  const status = req.body?.status === "explained" ? "explained" : "cleared";
  const [updated] = await db.update(schema.reconciliationRuns).set({
    status,
    explanation: req.body?.explanation ?? null,
    approvedBy: req.adminId ?? null,
    approvedAt: new Date(),
  }).where(eq(schema.reconciliationRuns.id, paramId(req.params.id))).returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAudit({
    userId: req.adminId,
    action: "approve",
    objectType: "reconciliation_run",
    objectId: updated.id,
    newValue: updated,
  });
  res.json(updated);
});

export const opsFormsRouter = Router();
opsFormsRouter.use(authMiddleware);

const FORM_CODES = ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06"] as const;

opsFormsRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  const data = await db.select().from(schema.opsFormEvents).orderBy(desc(schema.opsFormEvents.createdAt));
  res.json({ data, formCodes: FORM_CODES });
});

opsFormsRouter.post("/", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  const formCode = String(req.body?.formCode || "");
  if (!FORM_CODES.includes(formCode as typeof FORM_CODES[number])) {
    res.status(400).json({ error: `formCode must be one of ${FORM_CODES.join(", ")}` });
    return;
  }
  const [row] = await db.insert(schema.opsFormEvents).values({
    formCode,
    mandateId: req.body?.mandateId ?? null,
    portfolioId: req.body?.portfolioId ?? null,
    payload: req.body?.payload ?? {},
    status: "draft",
    createdBy: req.adminId ?? null,
  }).returning();
  await writeAudit({
    userId: req.adminId,
    action: "create",
    objectType: "ops_form_event",
    objectId: row.id,
    newValue: row,
  });
  res.status(201).json(row);
});

opsFormsRouter.post("/:id/approve", requireRole("admin", "approver"), async (req: AuthRequest, res) => {
  const [updated] = await db.update(schema.opsFormEvents).set({
    status: "approved",
    approvedBy: req.adminId ?? null,
    updatedAt: new Date(),
  }).where(eq(schema.opsFormEvents.id, paramId(req.params.id))).returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAudit({
    userId: req.adminId,
    action: "approve",
    objectType: "ops_form_event",
    objectId: updated.id,
    newValue: updated,
  });
  res.json(updated);
});
