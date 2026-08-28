import { Router } from "express";
import { authMiddleware, requireSuperAdmin, type AuthRequest } from "../middleware/auth.js";
import {
  ensureSystemConfigDefaults,
  getBundle,
  listUniverseForAdmin,
  refreshIlliquidFlagsFromAdtv,
  updateIpsLimit,
  updateStockClassification,
  updateSystemSetting,
} from "../services/system-config.js";
import { setApprovedListStatus } from "../services/research-engine.js";
import type { ApprovedListStatus } from "../db/schema/phase3.js";
import {
  deleteOfficialClose,
  importKbOfficialCloses,
  importOfficialClosesFromWorkbook,
  listOfficialCloses,
  officialClosesSummary,
  parseKbPriceMarkdown,
  upsertOfficialClose,
  upsertParsedOfficialCloses,
} from "../services/official-closes.js";
import {
  importKbIndexLevels,
  kbIndexLevelsSummary,
} from "../services/kb-indices.js";
import { cleanupUpload, historicalUpload } from "../services/upload-parser.js";
import fs from "node:fs";

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

const router = Router();
router.use(authMiddleware, requireSuperAdmin);

router.get("/", async (_req, res) => {
  try {
    res.json(await getBundle());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.post("/ensure-defaults", async (req: AuthRequest, res) => {
  try {
    await ensureSystemConfigDefaults();
    res.json(await getBundle());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Ensure failed" });
  }
});

router.put("/ips/:key", async (req: AuthRequest, res) => {
  try {
    const row = await updateIpsLimit({
      key: String(req.params.key),
      value: req.body?.value,
      description: req.body?.description,
      userId: req.adminId,
    });
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.put("/settings/:key", async (req: AuthRequest, res) => {
  try {
    const row = await updateSystemSetting({
      key: String(req.params.key),
      value: req.body?.value,
      confirmed: req.body?.confirmed,
      userId: req.adminId,
    });
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

router.get("/universe", async (_req, res) => {
  try {
    res.json({ data: await listUniverseForAdmin() });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Universe failed" });
  }
});

router.put("/universe/:stockId", async (req: AuthRequest, res) => {
  try {
    const stockId = String(req.params.stockId);
    const row = await updateStockClassification({
      stockId,
      shariahGroup: req.body?.shariahGroup,
      isIlliquid: req.body?.isIlliquid,
      isTradable: req.body?.isTradable,
      regulatoryStatus: req.body?.regulatoryStatus,
      userId: req.adminId,
    });

    if (req.body?.approvedListStatus) {
      await setApprovedListStatus({
        stockId,
        status: req.body.approvedListStatus as ApprovedListStatus,
        notes: req.body?.approvedListNotes,
        userId: req.adminId,
      });
    }

    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Stock update failed" });
  }
});

router.post("/refresh-illiquid", async (req: AuthRequest, res) => {
  try {
    res.json(await refreshIlliquidFlagsFromAdtv(req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Refresh failed" });
  }
});

router.get("/prices/summary", async (_req, res) => {
  try {
    res.json(await officialClosesSummary());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Summary failed" });
  }
});

router.get("/prices", async (req, res) => {
  try {
    res.json(await listOfficialCloses({
      ticker: typeof req.query.ticker === "string" ? req.query.ticker : undefined,
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      offset: req.query.offset != null ? Number(req.query.offset) : undefined,
    }));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "List failed" });
  }
});

router.post("/prices", async (req: AuthRequest, res) => {
  try {
    const row = await upsertOfficialClose({
      ticker: String(req.body?.ticker || ""),
      date: String(req.body?.date || ""),
      price: Number(req.body?.price ?? req.body?.closePrice),
      userId: req.adminId,
    });
    res.status(201).json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Save failed" });
  }
});

router.delete("/prices/:ticker/:date", async (req: AuthRequest, res) => {
  try {
    res.json(await deleteOfficialClose(String(req.params.ticker), String(req.params.date), req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});

router.post("/prices/import-kb", async (req: AuthRequest, res) => {
  try {
    req.setTimeout?.(10 * 60 * 1000);
    res.json(await importKbOfficialCloses({ userId: req.adminId }));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "KB import failed" });
  }
});

router.post("/prices/upload", historicalUpload.single("file"), async (req: AuthRequest, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file" });
    return;
  }
  try {
    const name = file.originalname.toLowerCase();
    if (name.endsWith(".md") || name.endsWith(".csv") || name.endsWith(".txt")) {
      const text = fs.readFileSync(file.path, "utf8");
      const parsed = name.endsWith(".md")
        ? parseKbPriceMarkdown(text)
        : parseKbPriceMarkdown(csvToMarkdownTable(text));
      const result = await upsertParsedOfficialCloses(parsed.rows);
      res.json({ parsed: parsed.rows.length, skippedParse: parsed.skipped, ...result });
      return;
    }
    res.json(await importOfficialClosesFromWorkbook(file.path, file.originalname, req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Upload failed" });
  } finally {
    cleanupUpload(file.path);
  }
});

router.get("/indices/summary", async (_req, res) => {
  try {
    res.json(await kbIndexLevelsSummary());
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Summary failed" });
  }
});

router.post("/indices/import-kb", async (req: AuthRequest, res) => {
  try {
    req.setTimeout?.(10 * 60 * 1000);
    res.json(await importKbIndexLevels({ userId: req.adminId }));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "KB index import failed" });
  }
});

function csvToMarkdownTable(csv: string): string {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const header = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const body = lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return `| ${cells.join(" | ")} |`;
  });
  return `| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n${body.join("\n")}\n`;
}

export default router;
