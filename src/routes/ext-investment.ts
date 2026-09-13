import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { isExtSqlConfigured } from "../db/mssql.js";
import { queryAsOf, param, queryToken } from "../utils/params.js";
import { getInvoiceReport } from "../services/ext-invoice-report.js";
import { invoiceReportWorkbook } from "../services/invoice-excel.js";
import {
  getFirmInvestmentPortfolio,
  getFirmInvestmentPortfolioDrilldown,
} from "../services/ext-firm-portfolio.js";
import { listClientCurrentOrders } from "../services/ext-client-orders.js";

const router = Router();
router.use(authMiddleware);

function todayQatar(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Qatar" });
}

function parseClientId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
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

function requireDateRange(req: import("express").Request, res: import("express").Response): { from: string; to: string } | null {
  const from = queryAsOf(req.query.from);
  const to = queryAsOf(req.query.to);
  if (!from || !to) {
    res.status(400).json({ error: "FROM_TO_REQUIRED", message: "Query from and to (YYYY-MM-DD) are required" });
    return null;
  }
  if (from > to) {
    res.status(400).json({ error: "DATE_RANGE_INVALID", message: "from must be on or before to" });
    return null;
  }
  return { from, to };
}

router.get("/invoices", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    const clientId = parseClientId(typeof req.query.clientId === "string" ? req.query.clientId : undefined);
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";
    res.json(await getInvoiceReport({
      from: range.from,
      to: range.to,
      clientId,
      ticker: ticker || null,
    }));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/invoices.xlsx", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    const clientId = parseClientId(typeof req.query.clientId === "string" ? req.query.clientId : undefined);
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";
    const report = await getInvoiceReport({
      from: range.from,
      to: range.to,
      clientId,
      ticker: ticker || null,
    });
    const { filename, buffer } = invoiceReportWorkbook(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/portfolio", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    res.json(await getFirmInvestmentPortfolio(asOf));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/portfolio/:ticker", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const ticker = param(req.params.ticker);
    const data = await getFirmInvestmentPortfolioDrilldown(asOf, ticker);
    if (!data) {
      res.status(404).json({ error: "NOT_FOUND", message: `No holders for ${ticker}` });
      return;
    }
    res.json(data);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/orders", async (req, res) => {
  try {
    const status = queryToken(req.query.status, /^[PASCERpascer]$/);
    res.json(await listClientCurrentOrders({ status: status ? status.toUpperCase() : null }));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

export default router;
