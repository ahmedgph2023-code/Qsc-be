import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import indicesRoutes from "./routes/indices.js";
import stocksRoutes from "./routes/stocks.js";
import customersRoutes from "./routes/customers.js";
import portfoliosRoutes from "./routes/portfolios.js";
import transactionsRoutes from "./routes/transactions.js";
import dashboardRoutes from "./routes/dashboard.js";
import sectorsRoutes from "./routes/sectors.js";
import mandatesRoutes from "./routes/mandates.js";
import phase1PortfoliosRoutes from "./routes/phase1-portfolios.js";
import builderRoutes from "./routes/builder.js";
import rebalancesRoutes from "./routes/rebalances.js";
import complianceRoutes, { riskRouter } from "./routes/compliance.js";
import auditRoutes from "./routes/audit.js";
import feesRoutes, { feeBandsRouter } from "./routes/fees.js";
import fixedIncomeRoutes from "./routes/fixed-income.js";
import historicalImportRoutes from "./routes/historical-import.js";
import portfolioFormulasRoutes from "./routes/portfolio-formulas.js";
import {
  simulatorRouter, ordersRouter, reportsRouter, reconciliationRouter, opsFormsRouter,
} from "./routes/phase2.js";
import {
  marketsRouter, screenerRouter, researchRouter,
} from "./routes/phase3.js";
import {
  aiRouter, commentaryRouter, scenariosRouter, frontierRouter,
} from "./routes/phase4.js";
import systemConfigRoutes from "./routes/system-config.js";
import usersRoutes from "./routes/users.js";
import extClientsRoutes from "./routes/ext-clients.js";
import snapshotsRoutes from "./routes/snapshots.js";
import liveRoutes from "./routes/live.js";
import productDecisionsRoutes from "./routes/product-decisions.js";
import statementQuestionsRoutes from "./routes/statement-questions.js";
import uatRoutes from "./routes/uat.js";
import balanceQuestionsRoutes from "./routes/balance-questions.js";
import clientReportsRoutes from "./routes/client-reports.js";
import whatsappRoutes, { webhookRouter } from "./routes/whatsapp.js";

const app = express();

/** CORS: in production require CORS_ORIGINS (comma-separated). Local default reflects any origin. */
function corsOrigin() {
  const raw = (process.env.CORS_ORIGINS || "").trim();
  if (raw) {
    const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return (origin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
      if (!origin || allowed.includes(origin)) cb(null, origin || true);
      else cb(new Error(`CORS blocked for origin ${origin}`));
    };
  }
  if (process.env.NODE_ENV === "production") {
    console.warn("[cors] CORS_ORIGINS unset in production — reflecting request Origin (set CORS_ORIGINS to tighten)");
  }
  return true;
}

app.use(cors({ origin: corsOrigin(), credentials: true }));

/** Meta WhatsApp webhook needs raw body for signature verification */
app.use(
  "/api/whatsapp/webhook",
  express.raw({ type: "application/json", limit: "25mb" }),
  (req, _res, next) => {
    const buf = req.body as Buffer;
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    try {
      req.body = buf?.length ? JSON.parse(buf.toString("utf8")) : {};
    } catch {
      req.body = {};
    }
    next();
  },
  webhookRouter,
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/indices", indicesRoutes);
app.use("/api/stocks", stocksRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/ext/clients", extClientsRoutes);
app.use("/api/portfolios", phase1PortfoliosRoutes);
app.use("/api/portfolios", portfoliosRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/sectors", sectorsRoutes);
app.use("/api/mandates", mandatesRoutes);
app.use("/api/mandates", feeBandsRouter);
app.use("/api/fees", feesRoutes);
app.use("/api/builder", builderRoutes);
app.use("/api/rebalances", rebalancesRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/risk", riskRouter);
app.use("/api/audit", auditRoutes);
app.use("/api/fi", fixedIncomeRoutes);
app.use("/api/historical-import", historicalImportRoutes);
app.use("/api/portfolio-formulas", portfolioFormulasRoutes);
app.use("/api/simulator", simulatorRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/reconciliation", reconciliationRouter);
app.use("/api/ops-forms", opsFormsRouter);
app.use("/api/markets", marketsRouter);
app.use("/api/screener", screenerRouter);
app.use("/api/research", researchRouter);
app.use("/api/ai", aiRouter);
app.use("/api/commentary", commentaryRouter);
app.use("/api/scenarios", scenariosRouter);
app.use("/api/frontier", frontierRouter);
app.use("/api/system-config", systemConfigRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/snapshots", snapshotsRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/product-decisions", productDecisionsRoutes);
app.use("/api/statement-questions", statementQuestionsRoutes);
app.use("/api/uat", uatRoutes);
app.use("/api/balance-questions", balanceQuestionsRoutes);
app.use("/api/client-reports", clientReportsRoutes);
app.use("/api/whatsapp", whatsappRoutes);

app.get("/api/health", (_req, res) => { res.json({ status: "ok" }); });

export default app;
