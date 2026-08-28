import { Router } from "express";
import { authMiddleware, requireSuperAdmin, type AuthRequest } from "../middleware/auth.js";
import { historicalUpload, cleanupUpload } from "../services/upload-parser.js";
import { catalogPublic, SHEET_KINDS, type SheetKind } from "../services/historical-sheet.js";
import {
  commitHistoricalFile,
  deleteHistoricalImport,
  listHistoricalImports,
  validateHistoricalFile,
} from "../services/historical-import.js";
import { previewPortfolioFromWorkbooks } from "../services/sheet-portfolio-preview.js";
import { param } from "../utils/params.js";
import { writeAudit } from "../services/audit.js";

const router = Router();
router.use(authMiddleware, requireSuperAdmin);

function isSheetKind(value: unknown): value is SheetKind {
  return typeof value === "string" && (SHEET_KINDS as readonly string[]).includes(value);
}

function uploadSingle(req: AuthRequest, res: import("express").Response, next: import("express").NextFunction) {
  historicalUpload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(400).json({ error: "UPLOAD_FAILED", message });
      return;
    }
    next();
  });
}

function uploadPair(req: AuthRequest, res: import("express").Response, next: import("express").NextFunction) {
  historicalUpload.fields([
    { name: "trades", maxCount: 1 },
    { name: "cash", maxCount: 1 },
  ])(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(400).json({ error: "UPLOAD_FAILED", message });
      return;
    }
    next();
  });
}

router.get("/catalog", (_req, res) => {
  res.json({ steps: catalogPublic() });
});

router.get("/", async (_req, res) => {
  try {
    res.json(await listHistoricalImports());
  } catch (err: any) {
    res.status(500).json({ error: err.cause?.message || err.message });
  }
});

router.post("/validate", uploadSingle, async (req: AuthRequest, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "NO_FILE", message: "Excel file required" }); return; }
    const requested = isSheetKind(req.body?.kind) ? req.body.kind : null;
    const result = validateHistoricalFile(req.file.path, req.file.originalname, requested);
    cleanupUpload(req.file.path);
    res.json(result);
  } catch (err: any) {
    if (req.file) cleanupUpload(req.file.path);
    res.status(500).json({ error: err.cause?.message || err.message });
  }
});

router.post("/preview-portfolio", uploadPair, async (req: AuthRequest, res) => {
  const files = req.files as { trades?: Express.Multer.File[]; cash?: Express.Multer.File[] } | undefined;
  const trades = files?.trades?.[0];
  const cash = files?.cash?.[0];
  try {
    if (!trades || !cash) {
      res.status(400).json({ error: "BOTH_FILES", message: "trades and cash workbooks are required" });
      return;
    }
    const asOf = typeof req.body?.asOf === "string" && req.body.asOf ? req.body.asOf : undefined;
    const result = await previewPortfolioFromWorkbooks({
      tradesPath: trades.path,
      tradesName: trades.originalname,
      cashPath: cash.path,
      cashName: cash.originalname,
      asOf,
      clientName: typeof req.body?.name === "string" ? req.body.name : "",
      clientCode: typeof req.body?.accountNumber === "string" ? req.body.accountNumber : "",
    });
    cleanupUpload(trades.path);
    cleanupUpload(cash.path);
    res.json(result);
  } catch (err: any) {
    if (trades) cleanupUpload(trades.path);
    if (cash) cleanupUpload(cash.path);
    res.status(500).json({ error: err.cause?.message || err.message });
  }
});

router.post("/commit", uploadSingle, async (req: AuthRequest, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "NO_FILE", message: "Excel file required" }); return; }
    if (!isSheetKind(req.body?.kind)) {
      cleanupUpload(req.file.path);
      res.status(400).json({ error: "KIND_REQUIRED", message: "kind must be one of the six QSC sheets" });
      return;
    }
    const replace = String(req.body?.replace || "").toLowerCase() === "true" || req.body?.replace === true;
    const customerId = typeof req.body?.customerId === "string" && req.body.customerId ? req.body.customerId : null;
    const row = await commitHistoricalFile({
      filePath: req.file.path,
      fileName: req.file.originalname,
      kind: req.body.kind,
      replace,
      customerId,
      createdBy: req.adminId || null,
    });
    cleanupUpload(req.file.path);
    await writeAudit({
      userId: req.adminId,
      action: replace ? "update" : "create",
      objectType: "historical_import",
      objectId: row.id,
      newValue: { kind: row.kind, fileName: row.fileName, rowCount: row.rowCount, replace },
    });
    res.status(201).json(row);
  } catch (err: any) {
    if (req.file) cleanupUpload(req.file.path);
    const status = Number(err.status) || 500;
    res.status(status).json({
      error: err.error || "COMMIT_FAILED",
      message: err.cause?.message || err.message,
      details: err.details,
    });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const row = await deleteHistoricalImport(param(req.params.id), req.adminId || null);
    res.json(row);
  } catch (err: any) {
    const status = Number(err.status) || 500;
    res.status(status).json({ error: err.error || "DELETE_FAILED", message: err.cause?.message || err.message });
  }
});

export default router;
