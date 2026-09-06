import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { isExtSqlConfigured } from "../db/mssql.js";
import { queryAsOf, param, queryPagination, querySearchLike, queryToken } from "../utils/params.js";
import {
  getAccountStatement,
  getExtCashLedger,
  getExtClient,
  getExtSharesLedger,
  getPortfolioStatement,
  getRealizedDetailsStatement,
  getRealizedSummaryStatement,
  getSyncStatus,
  listExtClients,
} from "../services/ext-sql-clients.js";
import { statementWorkbook } from "../services/statement-excel.js";

const router = Router();
router.use(authMiddleware);

function todayQatar(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Qatar" });
}

function parseClientId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

function handleExtError(res: import("express").Response, err: any) {
  const status = err?.status === 503 || err?.code === "EXT_SQL_UNCONFIGURED" ? 503 : 500;
  res.status(status).json({
    error: err?.code || "EXT_SQL_ERROR",
    message: err?.cause?.message || err?.message || "External SQL query failed",
  });
}

router.use((_req, res, next) => {
  if (!isExtSqlConfigured()) {
    res.status(503).json({
      error: "EXT_SQL_UNCONFIGURED",
      message: "External SQL connection is not configured",
    });
    return;
  }
  next();
});

router.get("/sync-status", async (_req, res) => {
  try {
    res.json(await getSyncStatus());
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    res.json(await listExtClients(asOf));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/shares", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const { page, pageSize } = queryPagination(req.query);
    const side = queryToken(req.query.side, /^(BUY|SELL|SP)$/i);
    const invType = queryToken(req.query.invType, /^(OI|OC|NI|SP)$/i);
    res.json(await getExtSharesLedger(clientId, asOf, page, pageSize, {
      qLike: querySearchLike(req.query.q),
      side: side ? side.toUpperCase() : null,
      invType: invType ? invType.toUpperCase() : null,
    }));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

function requireDateRange(req: import("express").Request, res: import("express").Response): { from: string; to: string } | null {
  const from = queryAsOf(req.query.from);
  const to = queryAsOf(req.query.to);
  if (!from || !to) {
    res.status(400).json({
      error: "FROM_TO_REQUIRED",
      message: "Query from and to (YYYY-MM-DD) are required",
    });
    return null;
  }
  if (from > to) {
    res.status(400).json({
      error: "DATE_RANGE_INVALID",
      message: "from must be on or before to",
    });
    return null;
  }
  return { from, to };
}

function sendWorkbook(res: import("express").Response, stmt: Parameters<typeof statementWorkbook>[0]) {
  const { filename, buffer } = statementWorkbook(stmt);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

router.get("/:id/statements/portfolio.xlsx", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const includeZeroQty = req.query.includeZeroQty === "1" || req.query.includeZeroQty === "true";
    const stmt = await getPortfolioStatement(clientId, asOf, new Date().toISOString(), { includeZeroQty });
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    sendWorkbook(res, stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/portfolio", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const includeZeroQty = req.query.includeZeroQty === "1" || req.query.includeZeroQty === "true";
    const stmt = await getPortfolioStatement(clientId, asOf, new Date().toISOString(), { includeZeroQty });
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    res.json(stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/account.xlsx", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const layout = String(req.query.layout || "grouped").toLowerCase() === "detailed" ? "detailed" : "grouped";
    const stmt = await getAccountStatement(clientId, range.from, range.to, new Date().toISOString(), layout);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    sendWorkbook(res, stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/account", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const layout = String(req.query.layout || "grouped").toLowerCase() === "detailed" ? "detailed" : "grouped";
    const stmt = await getAccountStatement(clientId, range.from, range.to, new Date().toISOString(), layout);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    res.json(stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/realized-summary.xlsx", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const stmt = await getRealizedSummaryStatement(clientId, range.from, range.to);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    sendWorkbook(res, stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/realized-summary", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const stmt = await getRealizedSummaryStatement(clientId, range.from, range.to);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    res.json(stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/realized-details.xlsx", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker : null;
    const stmt = await getRealizedDetailsStatement(clientId, range.from, range.to, new Date().toISOString(), ticker);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    sendWorkbook(res, stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/statements/realized-details", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const range = requireDateRange(req, res);
    if (!range) return;
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker : null;
    const stmt = await getRealizedDetailsStatement(clientId, range.from, range.to, new Date().toISOString(), ticker);
    if (!stmt) { res.status(404).json({ error: "Not found" }); return; }
    res.json(stmt);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id/cash", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const from = queryAsOf(req.query.from);
    const { page, pageSize } = queryPagination(req.query);
    res.json(await getExtCashLedger(clientId, asOf, page, pageSize, {
      qLike: querySearchLike(req.query.q),
      status: queryToken(req.query.status, /^[A-Za-z]$/),
      from: from ?? null,
    }));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const clientId = parseClientId(param(req.params.id));
    if (clientId == null) { res.status(400).json({ error: "INVALID_CLIENT_ID" }); return; }
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const client = await getExtClient(clientId, asOf);
    if (!client) { res.status(404).json({ error: "Not found" }); return; }
    res.json(client);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

export default router;
