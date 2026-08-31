import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getDashboardMetrics, getAumTrajectory, getAumVsIndex } from "../services/calculations.js";
import { getSqlFirmOverview } from "../services/sql-dashboard.js";
import { queryAsOf } from "../utils/params.js";

const router = Router();
router.use(authMiddleware);

router.get("/metrics", async (_req, res) => {
  try { res.json(await getDashboardMetrics()); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/aum-trajectory", async (_req, res) => {
  try { res.json(await getAumTrajectory()); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/aum-vs-index", async (req, res) => {
  try {
    const indexName = (req.query.index as string) || "QERI";
    const result = await getAumVsIndex(indexName);
    if (!result) { res.status(404).json({ error: `Index "${indexName}" not found or has no data` }); return; }
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

/** Firm overview from live QSC SQL ClientPortfolioSnapshot (not demo Postgres books). */
router.get("/sql-overview", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf);
    res.json(await getSqlFirmOverview(asOf));
  } catch (err: any) {
    const status = err?.status === 503 || err?.code === "EXT_SQL_UNCONFIGURED" ? 503 : 500;
    res.status(status).json({
      error: err?.code || "SQL_DASHBOARD_ERROR",
      message: err?.cause?.message || err?.message || "SQL dashboard failed",
    });
  }
});

export default router;
