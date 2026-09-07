import { Router } from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import {
  applyBroadcastPayload,
  getBroadcastStatus,
  getLiveExchangeSummary,
  getLiveIndices,
  getLiveQuotes,
  loadBroadcastSample,
  persistSessionCloses,
} from "../services/market-broadcast.js";

const router = Router();
router.use(authMiddleware);

router.get("/status", (_req, res) => {
  res.json(getBroadcastStatus());
});

router.get("/quotes", (_req, res) => {
  res.json({
    items: getLiveQuotes(),
    exchange: getLiveExchangeSummary(),
    status: getBroadcastStatus(),
  });
});

router.get("/indices", (_req, res) => {
  res.json({ items: getLiveIndices(), status: getBroadcastStatus() });
});

/** Manual / demo ingest of Hub-shaped JSON (meeting sample or Postman payload). */
router.post("/ingest", requireRole("admin", "pm"), (req, res) => {
  const result = applyBroadcastPayload(req.body);
  res.json({ ok: true, ...result, status: getBroadcastStatus() });
});

router.post("/load-sample", requireRole("admin", "pm"), (_req, res) => {
  const ok = loadBroadcastSample();
  if (!ok) {
    res.status(404).json({ error: "SAMPLE_NOT_FOUND", message: "BroadcastData.json not found" });
    return;
  }
  res.json({ ok: true, status: getBroadcastStatus() });
});

/** Persist current Last Prices as official closes for Qatar today (س-25). */
router.post("/persist-closes", requireRole("admin"), async (req, res) => {
  const asOf = typeof req.body?.asOf === "string" ? req.body.asOf : undefined;
  const result = await persistSessionCloses(asOf);
  res.json({ ok: true, ...result });
});

export default router;
