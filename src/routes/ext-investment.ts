import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { isExtSqlConfigured } from "../db/mssql.js";
import { queryAsOf, param, queryToken } from "../utils/params.js";
import { getInvoiceReport, listInvoiceClients, normalizeOrderType } from "../services/ext-invoice-report.js";
import { invoiceReportWorkbook } from "../services/invoice-excel.js";
import { invoiceReportPdf } from "../services/invoice-report-pdf.js";
import {
  getFirmInvestmentPortfolio,
  getFirmInvestmentPortfolioDrilldown,
} from "../services/ext-firm-portfolio.js";
import { firmHoldersWorkbook, firmPortfolioWorkbook } from "../services/firm-portfolio-excel.js";
import { firmHoldersPdf, firmPortfolioPdf } from "../services/firm-portfolio-pdf.js";
import {
  getAvailableBalances,
  getDailyExecutions,
  getOrderList,
  getPendingBoard,
  type ExecutionsView,
} from "../services/ext-orders-board.js";

const router = Router();
router.use(authMiddleware);

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sendFile(
  res: import("express").Response,
  file: { filename: string; buffer: Buffer },
  contentType: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}

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

/** Filters shared by the invoice JSON, Excel and PDF routes. */
function invoiceQuery(req: import("express").Request, range: { from: string; to: string }) {
  const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";
  const invNoRaw = typeof req.query.invNo === "string" ? req.query.invNo.trim() : "";
  const invNo = invNoRaw && /^\d+$/.test(invNoRaw) ? Number(invNoRaw) : null;
  return {
    from: range.from,
    to: range.to,
    clientId: parseClientId(typeof req.query.clientId === "string" ? req.query.clientId : undefined),
    ticker: ticker || null,
    orderType: normalizeOrderType(req.query.orderType),
    invNo,
  };
}

router.get("/invoices", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    res.json(await getInvoiceReport(invoiceQuery(req, range)));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

/** Customers invoiced inside the selected period (feeds the Customer filter). */
router.get("/invoices/clients", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim() : "";
    res.json(await listInvoiceClients({
      from: range.from,
      to: range.to,
      ticker: ticker || null,
      orderType: normalizeOrderType(req.query.orderType),
    }));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/invoices.xlsx", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    const report = await getInvoiceReport(invoiceQuery(req, range));
    sendFile(res, await invoiceReportWorkbook(report), XLSX_TYPE);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/invoices.pdf", async (req, res) => {
  try {
    const range = requireDateRange(req, res);
    if (!range) return;
    const report = await getInvoiceReport(invoiceQuery(req, range));
    sendFile(res, await invoiceReportPdf(report), "application/pdf");
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

router.get("/portfolio.xlsx", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const report = await getFirmInvestmentPortfolio(asOf);
    sendFile(res, await firmPortfolioWorkbook(report), XLSX_TYPE);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/portfolio.pdf", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const report = await getFirmInvestmentPortfolio(asOf);
    sendFile(res, await firmPortfolioPdf(report), "application/pdf");
  } catch (err: any) {
    handleExtError(res, err);
  }
});

/** Holders of one stock; `.xlsx` / `.pdf` on the ticker pick the export format. */
router.get("/portfolio/:ticker", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const raw = param(req.params.ticker);
    const format = raw.endsWith(".xlsx") ? "xlsx" : raw.endsWith(".pdf") ? "pdf" : "json";
    const ticker = format === "json" ? raw : raw.slice(0, raw.lastIndexOf("."));
    const data = await getFirmInvestmentPortfolioDrilldown(asOf, ticker);
    if (!data) {
      res.status(404).json({ error: "NOT_FOUND", message: `No holders for ${ticker}` });
      return;
    }
    if (format === "xlsx") {
      sendFile(res, await firmHoldersWorkbook(data), XLSX_TYPE);
      return;
    }
    if (format === "pdf") {
      sendFile(res, await firmHoldersPdf(data), "application/pdf");
      return;
    }
    res.json(data);
  } catch (err: any) {
    handleExtError(res, err);
  }
});

/** Daily Executions summary — one of the three Investment Manager groupings. */
router.get("/orders/summary", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    const raw = typeof req.query.view === "string" ? req.query.view : "";
    const view: ExecutionsView =
      raw === "stock" || raw === "client" || raw === "client_stock" ? raw : "client_stock";
    res.json(await getDailyExecutions(asOf, view));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

/** Cash for every client on the board (live order today or traded today). */
router.get("/orders/balances", async (req, res) => {
  try {
    const asOf = queryAsOf(req.query.asOf) || todayQatar();
    res.json(await getAvailableBalances(asOf));
  } catch (err: any) {
    handleExtError(res, err);
  }
});

/** Pending orders collapsed to one row per symbol × side. */
router.get("/orders/pending-board", async (_req, res) => {
  try {
    res.json(await getPendingBoard());
  } catch (err: any) {
    handleExtError(res, err);
  }
});

router.get("/orders", async (req, res) => {
  try {
    const status = queryToken(req.query.status, /^[PASCERpascer]$/);
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    res.json(
      await getOrderList({
        orderType: normalizeOrderType(req.query.orderType),
        ticker: text(req.query.ticker),
        status: status ? status.toUpperCase() : null,
        validity: text(req.query.validity),
        orderNo: text(req.query.orderNo),
        clientId: parseClientId(typeof req.query.clientId === "string" ? req.query.clientId : undefined),
        q: text(req.query.q),
      }),
    );
  } catch (err: any) {
    handleExtError(res, err);
  }
});

export default router;
