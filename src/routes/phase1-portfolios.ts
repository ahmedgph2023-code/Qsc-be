import { Router } from "express";
import { param, queryAsOf } from "../utils/params.js";
import { db, schema } from "../db/connection.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { getPortfolioMetrics, getPortfolioValueHistory, getCashBalanceAsOf, getNavDailyChanges, calculateTWAR, getMonthlySimpleReturns, getPerformanceVsIndex } from "../services/calculations.js";
import { getExcelIndexPerformance } from "../services/excel-workbook-engine.js";
import { signedCashDelta } from "../services/cash-sign.js";
import { writeAudit } from "../services/audit.js";
import { adjustActiveBandHwm } from "../services/fee-engine.js";
import { buildPortfolioSnapshot } from "../services/rebalance-engine.js";

const router = Router();
router.use(authMiddleware);

router.get("/manager", async (req, res) => {
  try {
    const all = await db.select().from(schema.portfolios).where(eq(schema.portfolios.status, "active"));
    const rows = [];
    for (const p of all) {
      const customers = await db.select().from(schema.customers).where(eq(schema.customers.id, p.customerId)).limit(1);
      const customer = customers[0];
      const mandates = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, p.customerId)).limit(1);
      const mandate = mandates[0];
      const metrics = await getPortfolioMetrics(p.id);
      const cash = Number(p.cashBalance ?? 0);
      const nav = (metrics.currentValue || 0) + cash;
      const riskCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.riskAlerts)
        .where(and(eq(schema.riskAlerts.portfolioId, p.id), eq(schema.riskAlerts.status, "open")));
      const excCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.complianceExceptions)
        .where(and(eq(schema.complianceExceptions.portfolioId, p.id), eq(schema.complianceExceptions.status, "requested")));
      const pendingRb = await db.select().from(schema.rebalances)
        .where(and(eq(schema.rebalances.portfolioId, p.id), eq(schema.rebalances.lockStatus, "draft")))
        .limit(1);

      const shariah = (req.query.shariah as string) || "";
      const risk = (req.query.risk as string) || "";
      const mandateStatus = (req.query.mandateStatus as string) || "";
      const breaches = req.query.breaches as string;

      if (shariah && mandate?.shariahPreference !== shariah) continue;
      if (risk && mandate?.riskProfile !== risk) continue;
      if (mandateStatus && mandate?.approvalStatus !== mandateStatus) continue;
      if (breaches === "1" && (riskCount[0]?.c ?? 0) === 0) continue;

      rows.push({
        portfolioId: p.id,
        customerId: p.customerId,
        customerName: customer?.name ?? "",
        accountNumber: customer?.accountNumber ?? null,
        nav,
        cash,
        invested: metrics.currentValue || 0,
        returnPct: metrics.returnPct || 0,
        shariahPreference: mandate?.shariahPreference ?? null,
        riskProfile: mandate?.riskProfile ?? null,
        mandateStatus: mandate?.approvalStatus ?? "missing",
        openRiskAlerts: riskCount[0]?.c ?? 0,
        openComplianceExceptions: excCount[0]?.c ?? 0,
        pendingRebalance: pendingRb.length > 0,
      });
    }
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/:id/phase1", async (req, res) => {
  try {
    const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, param(req.params.id))).limit(1);
    if (!portfolios[0]) { res.status(404).json({ error: "Not found" }); return; }
    const asOf = queryAsOf(req.query.asOf);
    const p = portfolios[0];
    const [customers, mandates, metrics, valueHistory] = await Promise.all([
      db.select().from(schema.customers).where(eq(schema.customers.id, p.customerId)).limit(1),
      db.select().from(schema.mandates).where(eq(schema.mandates.customerId, p.customerId)).limit(1),
      getPortfolioMetrics(p.id, asOf),
      getPortfolioValueHistory(p.id, asOf),
    ]);
    const holdings = metrics.holdings;
    const cash = metrics.cashBalance;
    const nav = metrics.navValue;
    const allocation = metrics.allocation;
    const [snapshot, twar, monthly, vsIndex, indexPerf, dailyChanges, riskAlerts, exceptions, rebalances] = await Promise.all([
      buildPortfolioSnapshot(p.id),
      calculateTWAR(p.id, asOf),
      getMonthlySimpleReturns(p.id, asOf),
      getPerformanceVsIndex(p.id, asOf, valueHistory),
      getExcelIndexPerformance(p.id, asOf),
      getNavDailyChanges(p.id, asOf, 120, valueHistory),
      db.select().from(schema.riskAlerts)
        .where(and(eq(schema.riskAlerts.portfolioId, p.id), eq(schema.riskAlerts.status, "open"))),
      db.select().from(schema.complianceExceptions)
        .where(eq(schema.complianceExceptions.portfolioId, p.id)),
      db.select().from(schema.rebalances)
        .where(eq(schema.rebalances.portfolioId, p.id))
        .orderBy(desc(schema.rebalances.proposedAt))
        .limit(10),
    ]);

    const asOfDate = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date();
    const y = asOf ? asOfDate.getUTCFullYear() : asOfDate.getFullYear();
    const m = asOf ? asOfDate.getUTCMonth() + 1 : asOfDate.getMonth() + 1;
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const mtd = monthly.find((r) => r.year === y && r.month === m)?.simpleReturnPct ?? null;
    const ytdRows = monthly.filter((r) => r.year === y);
    const ytd = ytdRows.length
      ? ytdRows.reduce((acc, r) => acc * (1 + r.simpleReturnPct / 100), 1) * 100 - 100
      : null;
    const qtdRows = monthly.filter((r) => r.year === y && r.month >= qStartMonth && r.month <= m);
    const qtd = qtdRows.length
      ? qtdRows.reduce((acc, r) => acc * (1 + r.simpleReturnPct / 100), 1) * 100 - 100
      : null;

    res.json({
      summary: {
        customer: customers[0],
        portfolio: p,
        mandate: mandates[0] ?? null,
      },
      valuation: {
        nav,
        invested: metrics.currentValue || 0,
        cash,
        totalInvested: metrics.totalInvested || 0,
      },
      excelWorkbook: {
        ...metrics.excelWorkbook,
        indexPerformancePct: indexPerf?.returnPct ?? null,
        indexName: indexPerf?.indexName ?? null,
        indexFromDate: indexPerf?.fromDate ?? null,
        indexToDate: indexPerf?.toDate ?? null,
      },
      dailyChanges,
      allocation,
      performance: {
        mtd, qtd, ytd,
        sinceInception: metrics.returnPct ?? null,
        twar: twar.twar,
        vsIndex,
      },
      risk: {
        sectors: snapshot.sectors,
        topWeight: snapshot.metrics.topWeight,
        alerts: riskAlerts,
      },
      holdings: holdings.map((h) => ({
        ...h,
        weight: h.excelWeight ?? (nav > 0 ? h.currentValue / nav : 0),
      })),
      actions: {
        riskAlerts,
        exceptions,
        recentRebalances: rebalances,
      },
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/:id/cash", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf);
    const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, param(req.params.id))).limit(1);
    if (!portfolios[0]) { res.status(404).json({ error: "Not found" }); return; }
    const ledger = await db.select().from(schema.cashTransactions)
      .where(eq(schema.cashTransactions.portfolioId, param(req.params.id)))
      .orderBy(desc(schema.cashTransactions.tradeDate));
    const clipped = asOf ? ledger.filter((r) => String(r.tradeDate).slice(0, 10) <= asOf) : ledger;
    const balance = asOf
      ? await getCashBalanceAsOf(param(req.params.id), asOf)
      : Number(portfolios[0].cashBalance ?? 0);
    res.json({ balance, ledger: clipped, asOf: asOf || null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/:id/cash", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const { type, amount, tradeDate, notes, reference } = req.body;
    if (!type || amount == null) { res.status(400).json({ error: "type and amount required" }); return; }
    const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, param(req.params.id))).limit(1);
    if (!portfolios[0]) { res.status(404).json({ error: "Not found" }); return; }

    const amt = Math.abs(Number(amount));
    const signed = signedCashDelta(type, amt);
    const newBal = Number(portfolios[0].cashBalance ?? 0) + signed;
    if (newBal < -0.01) { res.status(400).json({ error: "Insufficient cash" }); return; }

    const asOf = tradeDate || new Date().toISOString().slice(0, 10);
    if (type === "dividend") {
      const ledger = await db.select().from(schema.cashTransactions)
        .where(eq(schema.cashTransactions.portfolioId, param(req.params.id)));
      const dup = ledger.find((r) =>
        r.type === "dividend"
        && String(r.tradeDate).slice(0, 10) === asOf
        && Math.round(Math.abs(Number(r.amount)) * 10000) / 10000 === Math.round(amt * 10000) / 10000
      );
      if (dup) {
        res.status(400).json({ error: "Duplicate cash entry: same date, type, and amount already exists." });
        return;
      }
    }
    const [tx] = await db.insert(schema.cashTransactions).values({
      portfolioId: param(req.params.id),
      type,
      amount: String(amt),
      tradeDate: asOf,
      notes: notes || null,
      reference: reference || null,
      createdBy: req.userId,
    }).returning();

    await db.update(schema.portfolios).set({
      cashBalance: String(newBal),
      updatedAt: new Date(),
    }).where(eq(schema.portfolios.id, param(req.params.id)));

    if (type === "deposit") {
      await adjustActiveBandHwm(portfolios[0].customerId, amt, asOf);
    } else if (type === "withdrawal") {
      await adjustActiveBandHwm(portfolios[0].customerId, -amt, asOf);
    }

    await writeAudit({
      userId: req.userId, action: "create", objectType: "cash_transaction", objectId: tx.id, newValue: tx,
    });
    res.status(201).json({ transaction: tx, balance: newBal });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

const TRADE_CASH_TYPES = new Set(["trade_buy", "trade_sell"]);

async function reverseOneCashRow(cashId: string, portfolioId: string, userId?: string) {
  const [row] = await db.select().from(schema.cashTransactions)
    .where(and(eq(schema.cashTransactions.id, cashId), eq(schema.cashTransactions.portfolioId, portfolioId)))
    .limit(1);
  if (!row) {
    const err: any = new Error("Cash transaction not found");
    err.status = 404;
    throw err;
  }
  if (row.stockTransactionId || TRADE_CASH_TYPES.has(row.type)) {
    const err: any = new Error("This cash line belongs to a stock trade. Delete the trade in the Transactions tab instead.");
    err.status = 400;
    err.code = "LINKED_STOCK_TRADE";
    throw err;
  }
  if (row.corporateActionId) {
    const err: any = new Error("This cash line belongs to a corporate action. Delete the corporate action instead.");
    err.status = 400;
    err.code = "LINKED_CORPORATE_ACTION";
    throw err;
  }

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolio) {
    const err: any = new Error("Portfolio not found");
    err.status = 404;
    throw err;
  }

  const amt = Math.abs(Number(row.amount));
  const signed = signedCashDelta(row.type, amt);
  const newBal = Number(portfolio.cashBalance ?? 0) - signed;

  await db.update(schema.feeCharges)
    .set({ cashTransactionId: null, updatedAt: new Date() })
    .where(eq(schema.feeCharges.cashTransactionId, cashId));
  await db.update(schema.corporateActionApplications)
    .set({ cashTransactionId: null })
    .where(eq(schema.corporateActionApplications.cashTransactionId, cashId));

  await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.id, cashId));
  await db.update(schema.portfolios).set({
    cashBalance: String(newBal),
    updatedAt: new Date(),
  }).where(eq(schema.portfolios.id, portfolioId));

  const asOf = String(row.tradeDate).slice(0, 10);
  if (row.type === "deposit") {
    await adjustActiveBandHwm(portfolio.customerId, -amt, asOf);
  } else if (row.type === "withdrawal") {
    await adjustActiveBandHwm(portfolio.customerId, amt, asOf);
  }

  await writeAudit({
    userId, action: "delete", objectType: "cash_transaction", objectId: cashId, oldValue: row,
  });
  return { id: cashId, balance: newBal };
}

router.post("/:id/cash/bulk-delete", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const portfolioId = param(req.params.id);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "ids array is required" });
      return;
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    let balance: number | null = null;
    for (const id of ids) {
      try {
        const result = await reverseOneCashRow(id, portfolioId, req.userId);
        deleted.push(id);
        balance = result.balance;
      } catch (e: any) {
        errors.push(`${id}: ${e.message || "failed"}`);
      }
    }
    res.json({ count: deleted.length, deleted, errors, balance });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete("/:id/cash/:cashId", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const result = await reverseOneCashRow(param(req.params.cashId), param(req.params.id), req.userId);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

export default router;
