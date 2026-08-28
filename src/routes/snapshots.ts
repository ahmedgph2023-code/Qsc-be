import { Router } from "express";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { isExtSqlConfigured } from "../db/mssql.js";
import { queryAsOf } from "../utils/params.js";
import { todayQatar } from "../services/fee-engine.js";
import { listStoredSnapshots, runDailySnapshot } from "../services/snapshot-recon.js";

const router = Router();
router.use(authMiddleware);

function handleError(res: import("express").Response, err: unknown) {
  const e = err as { status?: number; code?: string; message?: string; cause?: { message?: string } };
  const status = e?.status === 503 || e?.code === "EXT_SQL_UNCONFIGURED" ? 503 : 500;
  res.status(status).json({
    error: e?.code || "SNAPSHOT_ERROR",
    message: e?.cause?.message || e?.message || "Snapshot request failed",
  });
}

router.get("/", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    res.json(await listStoredSnapshots(asOf));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/run", requireRole("pm", "approver", "compliance"), async (req: AuthRequest, res) => {
  try {
    if (!isExtSqlConfigured()) {
      res.status(503).json({
        error: "EXT_SQL_UNCONFIGURED",
        message: "External SQL connection is not configured",
      });
      return;
    }
    const asOf = queryAsOf(req.body?.asOf) || queryAsOf(req.query.asOf) || todayQatar();
    res.json(await runDailySnapshot(asOf, req.adminId ?? req.userId ?? null));
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
