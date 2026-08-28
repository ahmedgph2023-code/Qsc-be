import { Router } from "express";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { param } from "../utils/params.js";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { signedCashDelta } from "../services/cash-sign.js";
import {
  assertNoBandOverlap,
  generateFeeChargesForMonth,
  generateFeeChargesForPortfolio,
  previousMonth,
  todayQatar,
} from "../services/fee-engine.js";

const router = Router();
router.use(authMiddleware);

const tn = (v: unknown) => Number(v ?? 0);

function serializeBand(b: typeof schema.mandateFeeBands.$inferSelect) {
  return {
    ...b,
    rebateCommissionPct: tn(b.rebateCommissionPct),
    annualManagementFeePct: tn(b.annualManagementFeePct),
    performanceFeePct: tn(b.performanceFeePct),
    performanceHurdlePct: tn(b.performanceHurdlePct),
    highWaterMark: tn(b.highWaterMark),
  };
}

function serializeCharge(row: any, extra?: Record<string, unknown>) {
  return {
    ...row,
    ...extra,
    notional: tn(row.notional),
    holdingsMv: tn(row.holdingsMv),
    cashAsOf: tn(row.cashAsOf),
    nav: tn(row.nav),
    ratePct: tn(row.ratePct),
    amount: tn(row.amount),
    hwmBefore: row.hwmBefore == null ? null : tn(row.hwmBefore),
    excess: row.excess == null ? null : tn(row.excess),
    twrPct: row.twrPct == null ? null : tn(row.twrPct),
  };
}

router.get("/pending-count", requireRole("admin", "pm", "approver", "compliance"), async (_req, res) => {
  try {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.feeCharges)
      .where(eq(schema.feeCharges.status, "pending"));
    res.json({ count: row?.c ?? 0 });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/summary", requireRole("admin", "pm", "approver", "compliance"), async (_req, res) => {
  try {
    const rows = await db.select({
      type: schema.feeCharges.type,
      status: schema.feeCharges.status,
      amount: sql<number>`coalesce(sum(${schema.feeCharges.amount})::numeric, 0)`,
      count: sql<number>`count(*)::int`,
    }).from(schema.feeCharges).groupBy(schema.feeCharges.type, schema.feeCharges.status);

    let managementEarned = 0;
    let performanceEarned = 0;
    let rebatePaid = 0;
    let pendingCount = 0;
    let pendingAmount = 0;
    for (const r of rows) {
      const amt = tn(r.amount);
      if (r.status === "pending") {
        pendingCount += Number(r.count);
        pendingAmount += amt;
      }
      if (r.status !== "approved") continue;
      if (r.type === "management_fee") managementEarned += amt;
      if (r.type === "performance_fee") performanceEarned += amt;
      if (r.type === "rebate_commission") rebatePaid += amt;
    }
    res.json({ managementEarned, performanceEarned, rebatePaid, pendingCount, pendingAmount });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/charges", requireRole("admin", "pm", "approver", "compliance"), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 30));
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const type = typeof req.query.type === "string" ? req.query.type : "";
    const customerId = typeof req.query.customerId === "string" ? req.query.customerId : "";
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const filters = [];
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      filters.push(eq(schema.feeCharges.status, status as "pending" | "approved" | "rejected"));
    }
    if (type && ["rebate_commission", "management_fee", "performance_fee"].includes(type)) {
      filters.push(eq(schema.feeCharges.type, type as "rebate_commission" | "management_fee" | "performance_fee"));
    }
    if (customerId) filters.push(eq(schema.feeCharges.customerId, customerId));
    if (from) filters.push(gte(schema.feeCharges.periodMonth, from));
    if (to) filters.push(lte(schema.feeCharges.periodMonth, to));
    if (search) {
      filters.push(or(
        ilike(schema.customers.name, `%${search}%`),
        ilike(schema.customers.accountNumber, `%${search}%`),
      )!);
    }

    const where = filters.length ? and(...filters) : undefined;

    const [countRow] = await db.select({ c: sql<number>`count(*)::int` })
      .from(schema.feeCharges)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.feeCharges.customerId))
      .where(where);

    const total = countRow?.c ?? 0;
    const rows = await db.select({
      charge: schema.feeCharges,
      customerName: schema.customers.name,
      accountNumber: schema.customers.accountNumber,
    })
      .from(schema.feeCharges)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.feeCharges.customerId))
      .where(where)
      .orderBy(desc(schema.feeCharges.periodEndDate), desc(schema.feeCharges.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      data: rows.map((r) => serializeCharge(r.charge, {
        customerName: r.customerName,
        accountNumber: r.accountNumber,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/charges/generate", requireRole("pm", "admin"), async (req: AuthRequest, res) => {
  try {
    const portfolioId = typeof req.body?.portfolioId === "string" ? req.body.portfolioId : "";
    let month = typeof req.body?.month === "string" ? req.body.month : "";
    if (month && /^\d{4}-\d{2}$/.test(month) === false) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(month)) month = month.slice(0, 7);
      else { res.status(400).json({ error: "month must be YYYY-MM" }); return; }
    }
    if (portfolioId) {
      const months = month ? [month] : [];
      const result = await generateFeeChargesForPortfolio(portfolioId, months, { includeIncomplete: false });
      await writeAudit({
        userId: req.userId, action: "create", objectType: "fee_charge",
        newValue: { portfolioId, months },
      });
      res.json(result);
      return;
    }
    const ym = month || previousMonth(todayQatar().slice(0, 7));
    const result = await generateFeeChargesForMonth(ym);
    res.json({ month: ym, results: result });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

async function decideCharge(
  id: string,
  decision: "approved" | "rejected",
  userId: string | undefined,
  reason: string,
) {
  const [row] = await db.select().from(schema.feeCharges).where(eq(schema.feeCharges.id, id)).limit(1);
  if (!row) {
    const err: any = new Error("Charge not found");
    err.status = 404;
    throw err;
  }
  if (row.status !== "pending") {
    const err: any = new Error(`Charge is already ${row.status}`);
    err.status = 400;
    throw err;
  }

  if (decision === "rejected") {
    const [updated] = await db.update(schema.feeCharges).set({
      status: "rejected",
      rejectedBy: userId || null,
      rejectedAt: new Date(),
      decisionReason: reason || null,
      updatedAt: new Date(),
    }).where(eq(schema.feeCharges.id, id)).returning();
    await writeAudit({
      userId, action: "reject", objectType: "fee_charge", objectId: id,
      oldValue: row, newValue: updated, reason,
    });
    return updated;
  }

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, row.portfolioId)).limit(1);
  if (!portfolio) {
    const err: any = new Error("Portfolio not found");
    err.status = 404;
    throw err;
  }

  const amount = tn(row.amount);
  const cashType = row.type === "rebate_commission" ? "commission_rebate" : "fee";
  const signed = signedCashDelta(cashType, amount);
  const newBal = tn(portfolio.cashBalance) + signed;
  if (newBal < -0.01) {
    const err: any = new Error("Insufficient cash to post this fee");
    err.status = 400;
    throw err;
  }

  let cashTxId: string | null = null;
  if (amount > 0) {
    const [cashTx] = await db.insert(schema.cashTransactions).values({
      portfolioId: row.portfolioId,
      type: cashType,
      amount: String(amount),
      tradeDate: row.periodEndDate,
      notes: row.notes,
      reference: row.type,
      createdBy: userId || null,
    }).returning();
    cashTxId = cashTx.id;
    await db.update(schema.portfolios).set({
      cashBalance: String(newBal),
      updatedAt: new Date(),
    }).where(eq(schema.portfolios.id, row.portfolioId));
  }

  if (row.type === "performance_fee" && row.feeBandId) {
    const nav = tn(row.nav);
    const nextHwm = Math.max(0, round4(nav - amount));
    await db.update(schema.mandateFeeBands).set({
      highWaterMark: String(nextHwm),
      updatedAt: new Date(),
    }).where(eq(schema.mandateFeeBands.id, row.feeBandId));
  }

  const [updated] = await db.update(schema.feeCharges).set({
    status: "approved",
    approvedBy: userId || null,
    approvedAt: new Date(),
    decisionReason: reason || null,
    cashTransactionId: cashTxId,
    updatedAt: new Date(),
  }).where(eq(schema.feeCharges.id, id)).returning();

  await writeAudit({
    userId, action: "approve", objectType: "fee_charge", objectId: id,
    oldValue: row, newValue: updated, reason,
  });
  return updated;
}

function round4(n: number) { return Math.round(n * 10000) / 10000; }

router.post("/charges/:id/approve", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const updated = await decideCharge(param(req.params.id), "approved", req.userId, reason);
    res.json(serializeCharge(updated));
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post("/charges/:id/reject", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) { res.status(400).json({ error: "A rejection reason is required" }); return; }
    const updated = await decideCharge(param(req.params.id), "rejected", req.userId, reason);
    res.json(serializeCharge(updated));
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post("/charges/bulk-approve", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const results = [];
    const errors: string[] = [];
    for (const id of ids) {
      try { results.push(await decideCharge(id, "approved", req.userId, reason)); }
      catch (e: any) { errors.push(`${id}: ${e.message}`); }
    }
    res.json({ count: results.length, errors });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/charges/bulk-reject", requireRole("approver", "admin"), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) { res.status(400).json({ error: "A rejection reason is required" }); return; }
    const results = [];
    const errors: string[] = [];
    for (const id of ids) {
      try { results.push(await decideCharge(id, "rejected", req.userId, reason)); }
      catch (e: any) { errors.push(`${id}: ${e.message}`); }
    }
    res.json({ count: results.length, errors });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export const feeBandsRouter = Router();
feeBandsRouter.use(authMiddleware);

async function loadMandateByCustomer(customerId: string) {
  const rows = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, customerId)).limit(1);
  return rows[0] || null;
}

feeBandsRouter.get("/customer/:customerId/fee-bands", async (req, res) => {
  try {
    const mandate = await loadMandateByCustomer(param(req.params.customerId));
    if (!mandate) { res.json([]); return; }
    const bands = await db.select().from(schema.mandateFeeBands)
      .where(eq(schema.mandateFeeBands.mandateId, mandate.id))
      .orderBy(schema.mandateFeeBands.effectiveFrom);
    res.json(bands.map(serializeBand));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

feeBandsRouter.post("/customer/:customerId/fee-bands", requireRole("pm", "admin"), async (req: AuthRequest, res) => {
  try {
    const mandate = await loadMandateByCustomer(param(req.params.customerId));
    if (!mandate) { res.status(404).json({ error: "Mandate not found" }); return; }
    const effectiveFrom = String(req.body?.effectiveFrom || "").slice(0, 10);
    if (!effectiveFrom) { res.status(400).json({ error: "effectiveFrom is required" }); return; }
    const effectiveTo = req.body?.effectiveTo ? String(req.body.effectiveTo).slice(0, 10) : null;
    const existing = await db.select().from(schema.mandateFeeBands).where(eq(schema.mandateFeeBands.mandateId, mandate.id));
    assertNoBandOverlap(
      existing.map((b) => ({ id: b.id, effectiveFrom: String(b.effectiveFrom), effectiveTo: b.effectiveTo ? String(b.effectiveTo) : null })),
      { effectiveFrom, effectiveTo },
    );
    const hwm = req.body?.highWaterMark != null ? tn(req.body.highWaterMark) : tn(mandate.initialValue);
    const [created] = await db.insert(schema.mandateFeeBands).values({
      mandateId: mandate.id,
      effectiveFrom,
      effectiveTo,
      rebateCommissionPct: String(tn(req.body?.rebateCommissionPct)),
      annualManagementFeePct: String(tn(req.body?.annualManagementFeePct)),
      performanceFeePct: String(tn(req.body?.performanceFeePct)),
      performanceFrequency: req.body?.performanceFrequency === "quarterly" ? "quarterly" : "annual",
      performanceHurdlePct: String(tn(req.body?.performanceHurdlePct)),
      highWaterMark: String(hwm),
      notes: req.body?.notes || null,
    }).returning();
    await writeAudit({
      userId: req.userId, action: "create", objectType: "mandate_fee_band", objectId: created.id, newValue: created,
    });
    res.status(201).json(serializeBand(created));
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

feeBandsRouter.put("/fee-bands/:bandId", requireRole("pm", "admin"), async (req: AuthRequest, res) => {
  try {
    const [band] = await db.select().from(schema.mandateFeeBands).where(eq(schema.mandateFeeBands.id, param(req.params.bandId))).limit(1);
    if (!band) { res.status(404).json({ error: "Band not found" }); return; }
    const effectiveFrom = String(req.body?.effectiveFrom || band.effectiveFrom).slice(0, 10);
    const effectiveTo = req.body?.effectiveTo === "" || req.body?.effectiveTo == null
      ? null
      : String(req.body.effectiveTo).slice(0, 10);
    const existing = await db.select().from(schema.mandateFeeBands).where(eq(schema.mandateFeeBands.mandateId, band.mandateId));
    assertNoBandOverlap(
      existing.map((b) => ({ id: b.id, effectiveFrom: String(b.effectiveFrom), effectiveTo: b.effectiveTo ? String(b.effectiveTo) : null })),
      { id: band.id, effectiveFrom, effectiveTo },
    );
    const freq = req.body?.performanceFrequency;
    const [updated] = await db.update(schema.mandateFeeBands).set({
      effectiveFrom,
      effectiveTo,
      rebateCommissionPct: String(tn(req.body?.rebateCommissionPct ?? band.rebateCommissionPct)),
      annualManagementFeePct: String(tn(req.body?.annualManagementFeePct ?? band.annualManagementFeePct)),
      performanceFeePct: String(tn(req.body?.performanceFeePct ?? band.performanceFeePct)),
      performanceFrequency: freq === "quarterly" || freq === "annual" ? freq : band.performanceFrequency,
      performanceHurdlePct: String(tn(req.body?.performanceHurdlePct ?? band.performanceHurdlePct)),
      highWaterMark: String(tn(req.body?.highWaterMark ?? band.highWaterMark)),
      notes: req.body?.notes !== undefined ? (req.body.notes || null) : band.notes,
      updatedAt: new Date(),
    }).where(eq(schema.mandateFeeBands.id, band.id)).returning();
    await writeAudit({
      userId: req.userId, action: "update", objectType: "mandate_fee_band", objectId: band.id,
      oldValue: band, newValue: updated,
    });
    res.json(serializeBand(updated));
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

feeBandsRouter.delete("/fee-bands/:bandId", requireRole("pm", "admin"), async (req: AuthRequest, res) => {
  try {
    const id = param(req.params.bandId);
    await db.delete(schema.mandateFeeBands).where(eq(schema.mandateFeeBands.id, id));
    await writeAudit({ userId: req.userId, action: "delete", objectType: "mandate_fee_band", objectId: id });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
