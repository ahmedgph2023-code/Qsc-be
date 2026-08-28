import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getDashboardMetrics, getAumTrajectory, getAumVsIndex } from "../services/calculations.js";

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

export default router;
