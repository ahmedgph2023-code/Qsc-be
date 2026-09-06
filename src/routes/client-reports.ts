import { Router } from "express";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import {
  listClientReportBoard,
  getGlobalClientReportConfig,
  updateGlobalClientReportConfig,
  updateClientReportDeliveryConfig,
  getClientReportConfig,
  createClientReportConfig,
  updateClientReportConfig,
  deleteClientReportConfig,
  toggleClientReportConfig,
  toggleClientReportByExtId,
  previewClientReport,
  previewClientReportByExtId,
  sendClientReport,
  sendClientReportByExtId,
  ALL_REPORT_SECTIONS,
} from "../services/client-report-engine.js";
import {
  disconnectLinkDeviceSession,
  getLinkDeviceSession,
  startLinkDeviceSession,
} from "../services/link-device-session.js";

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

const router = Router();
router.use(authMiddleware, requireRole("admin", "pm"));

router.get("/sections", (_req, res) => {
  res.json({ sections: ALL_REPORT_SECTIONS });
});

router.get("/global", async (_req, res) => {
  try {
    res.json(await getGlobalClientReportConfig());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.put("/global", async (req: AuthRequest, res) => {
  try {
    res.json(await updateGlobalClientReportConfig(req.body, req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.put("/delivery", async (req: AuthRequest, res) => {
  try {
    res.json(await updateClientReportDeliveryConfig(req.body, req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.get("/delivery/link-device", (_req, res) => {
  res.json(getLinkDeviceSession());
});

router.post("/delivery/link-device/start", async (req: AuthRequest, res) => {
  try {
    const label = typeof req.body?.sessionLabel === "string" ? req.body.sessionLabel : null;
    res.json(await startLinkDeviceSession(label));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Failed to start link session" });
  }
});

router.post("/delivery/link-device/disconnect", async (_req, res) => {
  try {
    res.json(await disconnectLinkDeviceSession());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Disconnect failed" });
  }
});

router.get("/", async (_req, res) => {
  try {
    res.json(await listClientReportBoard());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.patch("/clients/:extClientId/toggle", async (req: AuthRequest, res) => {
  try {
    const extClientId = Number(req.params.extClientId);
    const enabled = Boolean(req.body?.enabled);
    res.json(await toggleClientReportByExtId(extClientId, enabled, req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Toggle failed" });
  }
});

router.get("/clients/:extClientId/preview", async (req, res) => {
  try {
    res.json(await previewClientReportByExtId(Number(req.params.extClientId)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Preview failed" });
  }
});

router.post("/clients/:extClientId/send", async (req: AuthRequest, res) => {
  try {
    res.json(await sendClientReportByExtId(Number(req.params.extClientId), req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Send failed" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    res.json(await getClientReportConfig(String(req.params.id)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.post("/", async (req: AuthRequest, res) => {
  try {
    const row = await createClientReportConfig(req.body, req.adminId ?? req.userId ?? null);
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Create failed" });
  }
});

router.put("/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await updateClientReportConfig(String(req.params.id), req.body, req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    res.json(await deleteClientReportConfig(String(req.params.id), req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});

router.patch("/:id/toggle", async (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    res.json(await toggleClientReportConfig(String(req.params.id), enabled, req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Toggle failed" });
  }
});

router.get("/:id/preview", async (req, res) => {
  try {
    res.json(await previewClientReport(String(req.params.id)));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Preview failed" });
  }
});

router.post("/:id/send", async (req: AuthRequest, res) => {
  try {
    res.json(await sendClientReport(String(req.params.id), "manual", req.adminId ?? req.userId ?? null));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Send failed" });
  }
});

export default router;
