import { Router } from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import {
  applyBroadcastPayload,
  getBroadcastStatus,
  getCloseSaveConfig,
  getLiveExchangeSummary,
  getLiveIndices,
  getLiveQuotes,
  loadBroadcastSample,
  persistSessionCloses,
  refreshFromQsePublicWebsite,
  setCloseSaveConfig,
  simulateLiveTicks,
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

/** Pull Market Watch snapshot from qe.com.qa public mw.php (QA fallback when Hub missing). */
router.post("/refresh-qse", requireRole("admin", "pm"), async (_req, res) => {
  const result = await refreshFromQsePublicWebsite();
  if (!result.ok) {
    res.status(502).json({
      error: "QSE_PUBLIC_UNAVAILABLE",
      message: result.error ?? "Could not reach QSE Market Watch",
      status: getBroadcastStatus(),
    });
    return;
  }
  res.json({ ok: true, quoteCount: result.quoteCount, status: getBroadcastStatus() });
});

/** Nudge Last Prices in memory for UI flash QA (no DB write). */
router.post("/simulate-ticks", requireRole("admin", "pm"), (req, res) => {
  const count = Number(req.body?.count);
  const result = simulateLiveTicks(Number.isFinite(count) ? count : 8);
  res.json({ ok: true, ...result, status: getBroadcastStatus() });
});

/** Persist current Last Prices as official closes for Qatar today (س-25). */
router.post("/persist-closes", requireRole("admin"), async (req, res) => {
  const asOf = typeof req.body?.asOf === "string" ? req.body.asOf : undefined;
  const result = await persistSessionCloses(asOf);
  res.json({ ok: true, ...result });
});

/** When Last Price is written to stock_prices (Asia/Qatar, Sun–Thu). */
router.get("/close-config", (_req, res) => {
  const config = getCloseSaveConfig();
  res.json({
    ...config,
    label: `${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} Asia/Qatar`,
    status: getBroadcastStatus(),
  });
});

router.put("/close-config", requireRole("admin", "pm"), (req, res) => {
  const hour = Number(req.body?.hour);
  const minute = req.body?.minute != null ? Number(req.body.minute) : undefined;
  if (!Number.isFinite(hour)) {
    res.status(400).json({ error: "INVALID_HOUR", message: "hour is required (0–23)" });
    return;
  }
  const config = setCloseSaveConfig({
    hour,
    minute: minute != null && Number.isFinite(minute) ? minute : undefined,
  });
  res.json({
    ok: true,
    ...config,
    label: `${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} Asia/Qatar`,
    status: getBroadcastStatus(),
  });
});

export default router;
