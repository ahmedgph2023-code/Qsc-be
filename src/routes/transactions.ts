import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq, asc, desc } from "drizzle-orm";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { upload, parseTransactionBulkExcel, cleanupUpload } from "../services/upload-parser.js";
import { sendTransactionTemplate } from "../services/template-generator.js";
import { createLotFromBuyTransaction, closeLotOnSell } from "../services/fixed-income/daily-pnl-engine.js";
import { executeStockTrade, reverseStockTradeCash, findClosingPriceOnDate, dayPriceBand } from "../services/trade-cash.js";
import { assertTradeEligibility, formatEligibilityReasons } from "../services/mandate-rules.js";
import { generateFeeChargesForPortfolio, adjustActiveBandHwm } from "../services/fee-engine.js";
import { applyCorporateActionToPortfolios } from "../services/corporate-action-portfolio.js";
import { signedCashDelta } from "../services/cash-sign.js";
import { param, queryAsOf } from "../utils/params.js";
import { parseStockTxType } from "../lib/tx-type.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const router = Router();
router.use(authMiddleware);

async function syncFiLot(tx: { id: string; type: string; stockId: string }) {
  try {
    const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, tx.stockId)).limit(1);
    if (!stock || stock.instrumentType === "equity") return;
    if (tx.type === "BUY" || tx.type === "CLIENT_TRANSFER") await createLotFromBuyTransaction(tx.id);
    else if (tx.type === "SELL") await closeLotOnSell(tx.id);
  } catch (err: any) {
    console.warn(`[fi] lot sync skipped for tx ${tx.id}: ${err.message}`);
  }
}

router.get("/portfolio/:portfolioId", async (req, res) => {
  try {
    const stockId = req.query.stockId as string | undefined;
    let query = db.select().from(schema.transactions).where(eq(schema.transactions.portfolioId, param(req.params.portfolioId))).$dynamic();
    if (stockId) query = query.where(eq(schema.transactions.stockId, stockId));
    const asOf = queryAsOf(req.query.asOf);
    const txs = (await query.orderBy(desc(schema.transactions.timestamp)))
      .filter((tx) => !asOf || tx.timestamp.toISOString().slice(0, 10) <= asOf);
    const result = await Promise.all(txs.map(async (tx) => {
      const stock = await db.select().from(schema.stocks).where(eq(schema.stocks.id, tx.stockId)).limit(1);
      return {
        ...tx,
        cashBalanceAfter: tx.cashBalanceAfter != null ? Number(tx.cashBalanceAfter) : null,
        quantity: Number(tx.quantity),
        price: Number(tx.price),
        stock: stock.length > 0 ? { ticker: stock[0].ticker, companyName: stock[0].companyName } : null,
      };
    }));
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/portfolio/:portfolioId", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const { stockId, type, quantity, price, timestamp, useClosingPrice } = req.body;
    if (!stockId || !type || quantity == null) {
      res.status(400).json({ error: "stockId, type, and quantity are required" });
      return;
    }
    const portfolioId = param(req.params.portfolioId);
    const tradeType = parseStockTxType(type);

    if (tradeType !== "CLIENT_TRANSFER") {
      const eligibility = await assertTradeEligibility({
        portfolioId,
        stockId,
        type: tradeType,
      });
      if (!eligibility.ok) {
        res.status(eligibility.status).json({
          error: eligibility.code || "NOT_ELIGIBLE",
          message: eligibility.message,
          reasons: eligibility.reasons || [],
        });
        return;
      }
    }

    const forceClosing = useClosingPrice === true || price == null || price === "" || Number(price) <= 0;
    const result = await executeStockTrade({
      portfolioId,
      stockId,
      type: tradeType,
      quantity: Number(quantity),
      price: forceClosing ? null : Number(price),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      forceClosingPrice: forceClosing,
      createdBy: req.userId || null,
    });

    await syncFiLot(result.transaction);

    res.status(201).json({
      ...result.transaction,
      quantity: Number(result.transaction.quantity),
      price: Number(result.transaction.price),
      cashBalanceAfter: result.cashBalanceAfter,
      tradeAmount: result.tradeAmount,
      priceSourceDate: result.priceSourceDate,
      dayLow: result.dayLow,
      dayHigh: result.dayHigh,
      cashTransactionId: result.cashTransaction?.id ?? null,
      warnings: [] as string[],
    });
  } catch (err: any) {
    const status = err.status || 500;
    res.status(status).json({ error: err.code || "TRADE_FAILED", message: err.message });
  }
});

router.post("/portfolio/:portfolioId/bulk", requireRole("admin", "pm"), upload.single("file"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const rows = parseTransactionBulkExcel(req.file.path);
    if (rows.length === 0) {
      res.status(400).json({
        error:
          "No valid data found. Expected columns: ticker, type, quantity, date, price (for BUY/SELL) " +
          "or type=TRANSFER (cash withdrawal) or CLIENT_TRANSFER (in-kind shares: ticker, quantity, date, price).",
      });
      cleanupUpload(req.file.path);
      return;
    }

    const portfolioId = param(req.params.portfolioId);
    const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
    if (!portfolios[0]) { cleanupUpload(req.file.path); res.status(404).json({ error: "Portfolio not found" }); return; }

    const skipPriceRange =
      req.body?.bypassHighLow === "true" ||
      req.body?.bypassHighLow === true ||
      req.body?.bypassHighLow === "1" ||
      req.body?.skipPriceRange === "true";

    const notSorted = rows.some((r, i) => i > 0 && r.date < rows[i - 1].date);
    if (notSorted) {
      const firstDrop = rows.findIndex((r, i) => i > 0 && r.date < rows[i - 1].date);
      const prev = rows[firstDrop - 1];
      const curr = rows[firstDrop];
      cleanupUpload(req.file.path);
      res.status(400).json({
        error:
          `Excel rows must be sorted by date ascending (oldest first). ` +
          `Row ${curr?.excelRow} (${curr?.date}) is before row ${prev?.excelRow} (${prev?.date}). ` +
          `Re-sort the date column and upload again.`,
      });
      return;
    }

    const inserted: string[] = [];
    const errors: string[] = [];
    const touchedStockIds = new Set<string>();
    let skippedRemaining = 0;
    let stoppedAt: string | null = null;

    const stop = (i: number, message: string) => {
      errors.push(message);
      skippedRemaining = rows.length - i - 1;
      stoppedAt = rows[i].date;
      if (skippedRemaining > 0) {
        errors.push(
          `Stopped at this row. ${skippedRemaining} later row(s) were not processed.`,
        );
      }
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNo = row.excelRow;
      try {
        if (row.type === "TRANSFER") {
          const amt = round4(Number(row.amount ?? 0));
          if (!Number.isFinite(amt) || amt <= 0) {
            stop(i, `Row ${rowNo} TRANSFER on ${row.date}: amount must be > 0`);
            break;
          }

          const [pRow] = await db
            .select({ cashBalance: schema.portfolios.cashBalance, customerId: schema.portfolios.customerId })
            .from(schema.portfolios)
            .where(eq(schema.portfolios.id, portfolioId))
            .limit(1);
          const cashBefore = Number(pRow?.cashBalance ?? 0);
          const signed = signedCashDelta("withdrawal", amt);
          const cashAfter = round4(cashBefore + signed);
          if (cashAfter < -0.01) {
            stop(i, `Row ${rowNo} TRANSFER ${amt.toFixed(2)} on ${row.date}: insufficient cash (balance ${cashBefore.toFixed(2)})`);
            break;
          }

          await db.insert(schema.cashTransactions).values({
            portfolioId,
            type: "withdrawal",
            amount: String(amt),
            tradeDate: row.date,
            reference: "BULK_TRANSFER",
            notes: "Transfer/withdrawal from bulk transaction upload",
            createdBy: req.userId || null,
          });
          await db.update(schema.portfolios).set({
            cashBalance: String(cashAfter),
            updatedAt: new Date(),
          }).where(eq(schema.portfolios.id, portfolioId));

          if (pRow?.customerId) await adjustActiveBandHwm(pRow.customerId, -amt, row.date);

          inserted.push(`TRANSFER ${amt.toFixed(2)} on ${row.date} → cash ${cashAfter.toFixed(2)}`);
          continue;
        }

        const stock = await db.select().from(schema.stocks).where(eq(schema.stocks.ticker, row.ticker)).limit(1);
        if (stock.length === 0) {
          stop(i, `Row ${rowNo} Stock "${row.ticker}" not found`);
          break;
        }
        const tradeType = parseStockTxType(row.type);
        if (tradeType !== "CLIENT_TRANSFER") {
          const eligibility = await assertTradeEligibility({
            portfolioId,
            stockId: stock[0].id,
            type: tradeType,
          });
          if (!eligibility.ok) {
            stop(i, `Row ${rowNo} ${row.ticker} ${tradeType}: ${eligibility.message}`);
            break;
          }
        }
        const result = await executeStockTrade({
          portfolioId,
          stockId: stock[0].id,
          type: tradeType,
          quantity: Number(row.quantity),
          price: Number(row.price),
          forceClosingPrice: false,
          skipPriceRange: tradeType === "CLIENT_TRANSFER" ? true : skipPriceRange,
          timestamp: new Date(row.date + "T00:00:00Z"),
          createdBy: req.userId || null,
        });
        await syncFiLot(result.transaction);
        touchedStockIds.add(stock[0].id);
        inserted.push(
          tradeType === "CLIENT_TRANSFER"
            ? `CLIENT_TRANSFER ${row.quantity} ${row.ticker} @ ${result.priceUsed} on ${row.date} (no cash)`
            : `${tradeType} ${row.quantity} ${row.ticker} @ ${result.priceUsed} on ${row.date} → cash ${result.cashBalanceAfter.toFixed(2)}`,
        );
      } catch (e: any) {
        stop(i, `Row ${rowNo} ${row.ticker || row.type} ${row.type}: ${e.message || "failed"}`);
        break;
      }
    }

    // Reconcile corporate actions dated on any of the stocks just traded: this portfolio may have
    // been created (or backfilled with historical trades) after those corporate actions already
    // existed, so replay them in date order to credit dividends / apply bonus-share dilution now.
    const corporateActionsApplied: Array<{
      ticker: string; actionType: string; actionDate: string; cashCredited: number; qtyDelta: number;
    }> = [];
    for (const stockId of touchedStockIds) {
      const cas = await db
        .select()
        .from(schema.corporateActions)
        .where(eq(schema.corporateActions.stockId, stockId))
        .orderBy(asc(schema.corporateActions.actionDate));
      if (cas.length === 0) continue;

      const [stockRow] = await db.select({ ticker: schema.stocks.ticker }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
      for (const ca of cas) {
        const impact = await applyCorporateActionToPortfolios(ca.id);
        const mine = impact.applications.find((a) => a.portfolioId === portfolioId);
        if (mine && (mine.cashAmount > 0 || mine.qtyDelta !== 0)) {
          corporateActionsApplied.push({
            ticker: stockRow?.ticker || "",
            actionType: ca.actionType,
            actionDate: ca.actionDate,
            cashCredited: mine.cashAmount,
            qtyDelta: mine.qtyDelta,
          });
        }
      }
    }

    cleanupUpload(req.file.path);
    let fees: unknown = null;
    if (inserted.length > 0) {
      try {
        fees = await generateFeeChargesForPortfolio(portfolioId, []);
      } catch (feeErr: any) {
        fees = { error: feeErr.message };
      }
    }
    const [p] = await db.select({ cashBalance: schema.portfolios.cashBalance }).from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
    res.json({
      count: inserted.length,
      inserted,
      errors,
      skippedRemaining,
      stoppedAt,
      bypassHighLow: skipPriceRange,
      cashBalance: Number(p?.cashBalance ?? 0),
      corporateActionsApplied,
      fees,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/template/download", (_req, res) => {
  sendTransactionTemplate(res);
});

router.get("/portfolio/:portfolioId/eligibility", async (req, res) => {
  try {
    const portfolioId = param(req.params.portfolioId);
    const stockId = typeof req.query.stockId === "string" ? req.query.stockId : "";
    const type = String(req.query.type || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
    if (!stockId) {
      res.status(400).json({ error: "stockId query param required" });
      return;
    }
    const eligibility = await assertTradeEligibility({ portfolioId, stockId, type });
    res.json({
      allowed: eligibility.ok,
      type,
      reasons: eligibility.reasons || [],
      warnings: eligibility.warnings || [],
      message: eligibility.ok
        ? (eligibility.warnings?.length
            ? formatEligibilityReasons(eligibility.warnings, { includeWarnings: true })
            : "Eligible")
        : eligibility.message,
      mandate: eligibility.mandate
        ? {
            id: eligibility.mandate.id,
            shariahPreference: eligibility.mandate.shariahPreference,
            riskProfile: eligibility.mandate.riskProfile,
            approvalStatus: eligibility.mandate.approvalStatus,
          }
        : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/closing-price/:stockId", async (req, res) => {
  try {
    const date = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    const found = await findClosingPriceOnDate(param(req.params.stockId), date);
    if (!found) { res.status(404).json({ error: "No closing price found" }); return; }
    const band = dayPriceBand(found);
    res.json({
      date,
      price: found.close,
      close: found.close,
      open: found.open,
      high: found.high,
      low: found.low,
      dayLow: band?.low ?? null,
      dayHigh: band?.high ?? null,
      sourceDate: found.sourceDate,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/portfolio/:portfolioId/bulk-delete", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const portfolioId = param(req.params.portfolioId);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "ids array is required" });
      return;
    }

    const rows = await db.select({
      id: schema.transactions.id,
      timestamp: schema.transactions.timestamp,
    }).from(schema.transactions).where(eq(schema.transactions.portfolioId, portfolioId));

    const allowed = new Set(rows.map((r) => r.id));
    const toDelete = ids.filter((id: string) => allowed.has(id));
    toDelete.sort((a: string, b: string) => {
      const ta = rows.find((r) => r.id === a)?.timestamp?.getTime() ?? 0;
      const tb = rows.find((r) => r.id === b)?.timestamp?.getTime() ?? 0;
      return tb - ta;
    });

    const deleted: string[] = [];
    const errors: string[] = [];
    let cashBalanceAfter: number | null = null;
    for (const id of toDelete) {
      try {
        const result = await reverseStockTradeCash(id);
        if (result.reversed) {
          deleted.push(id);
          if (result.cashBalanceAfter != null) cashBalanceAfter = result.cashBalanceAfter;
        } else {
          errors.push(`${id}: not found`);
        }
      } catch (e: any) {
        errors.push(`${id}: ${e.message || "failed"}`);
      }
    }

    res.json({
      count: deleted.length,
      deleted,
      errors,
      skipped: ids.length - toDelete.length,
      cashBalanceAfter,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id", requireRole("admin", "pm"), async (req, res) => {
  try {
    const result = await reverseStockTradeCash(param(req.params.id));
    if (!result.reversed) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ success: true, cashBalanceAfter: result.cashBalanceAfter ?? null });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
