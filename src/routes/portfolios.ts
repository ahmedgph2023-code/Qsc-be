import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq } from "drizzle-orm";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { getPortfolioMetrics, calculateTWAR, getPerformanceVsIndex, getPortfolioValueHistory, getMonthlyIndexReturns, getMonthlySimpleReturns, getNavDailyChanges } from "../services/calculations.js";
import { getExcelIndexPerformance } from "../services/excel-workbook-engine.js";
import { queryAsOf, param } from "../utils/params.js";

const router = Router();
router.use(authMiddleware);

router.get("/:id", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf);
    const portfolio = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, param(req.params.id))).limit(1);
    if (portfolio.length === 0) { res.status(404).json({ error: "Not found" }); return; }

    const metrics = await getPortfolioMetrics(req.params.id, asOf);
    const valueHistory = await getPortfolioValueHistory(req.params.id, asOf);
    const [twarResult, simpleMonthlyReturns, performance, indexPerf, dailyChanges] = await Promise.all([
      calculateTWAR(req.params.id, asOf),
      getMonthlySimpleReturns(req.params.id, asOf),
      getPerformanceVsIndex(req.params.id, asOf, valueHistory),
      getExcelIndexPerformance(req.params.id, asOf),
      getNavDailyChanges(req.params.id, asOf, 120, valueHistory),
    ]);

    let benchmarkIndex = null;
    if (portfolio[0].benchmarkIndexId) {
      const idx = await db.select().from(schema.indices).where(eq(schema.indices.id, portfolio[0].benchmarkIndexId)).limit(1);
      if (idx.length > 0) benchmarkIndex = idx[0];
    }

    const customer = await db.select().from(schema.customers).where(eq(schema.customers.id, portfolio[0].customerId)).limit(1);

    let indexMonthlyReturns: { year: number; month: number; returnPct: number }[] | null = null;
    if (simpleMonthlyReturns.length > 0) {
      const qeriIdx = await db.select().from(schema.indices).where(eq(schema.indices.name, "QERI")).limit(1);
      const first = simpleMonthlyReturns[0];
      if (qeriIdx.length > 0) {
        indexMonthlyReturns = await getMonthlyIndexReturns(qeriIdx[0].id, first.year, first.month);
      } else if (portfolio[0].benchmarkIndexId) {
        indexMonthlyReturns = await getMonthlyIndexReturns(portfolio[0].benchmarkIndexId, first.year, first.month);
      }
    }

    res.json({
      ...portfolio[0],
      customer: customer.length > 0 ? customer[0] : null,
      benchmarkIndex,
      ...metrics,
      excelWorkbook: {
        ...metrics.excelWorkbook,
        indexPerformancePct: indexPerf?.returnPct ?? null,
        indexName: indexPerf?.indexName ?? null,
        indexFromDate: indexPerf?.fromDate ?? null,
        indexToDate: indexPerf?.toDate ?? null,
      },
      dailyChanges,
      cashBalance: metrics.cashBalance,
      asOf: asOf || null,
      twar: twarResult.twar,
      subPeriods: twarResult.subPeriods,
      simpleMonthlyReturns,
      indexMonthlyReturns,
      performance,
      valueHistory: valueHistory.map((v) => ({ ...v, value: Math.round(v.value * 10000) / 10000 })),
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id/holdings", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf);
    const m = await getPortfolioMetrics(req.params.id, asOf);
    res.json(m.holdings);
  }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.put("/:id/benchmark", requireRole("admin", "pm"), async (req, res) => {
  try {
    const [u] = await db.update(schema.portfolios).set({ benchmarkIndexId: req.body.benchmarkIndexId || null }).where(eq(schema.portfolios.id, param(req.params.id))).returning();
    res.json(u);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try { await db.delete(schema.portfolios).where(eq(schema.portfolios.id, param(req.params.id))); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
