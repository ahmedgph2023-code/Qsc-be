import { Router } from "express";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { param } from "../utils/params.js";
import {
  closeLotOnSell,
  createLotFromBuyTransaction,
  rebuildLotDailyPnl,
  rebuildPortfolioDailyPnl,
  upsertFiInstrumentForStock,
} from "../services/fixed-income/daily-pnl-engine.js";
import { fiKindFromTicker, defaultCouponFrequency } from "../db/debt-tickers.js";

const router = Router();
router.use(authMiddleware);

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

router.get("/instruments", async (_req, res) => {
  const rows = await db
    .select({
      stock: schema.stocks,
      instrument: schema.fiInstruments,
    })
    .from(schema.stocks)
    .leftJoin(schema.fiInstruments, eq(schema.fiInstruments.stockId, schema.stocks.id))
    .where(sql`${schema.stocks.instrumentType} <> 'equity'`)
    .orderBy(asc(schema.stocks.ticker));
  res.json(rows.map((r) => ({
    ...r.stock,
    fi: r.instrument,
  })));
});

router.get("/instruments/:stockId", async (req, res) => {
  const stockId = param(req.params.stockId);
  const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, stockId));
  if (!stock) return res.status(404).json({ error: "Not found" });
  const [inst] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, stock.id));
  const schedule = inst
    ? await db.select().from(schema.fiCouponSchedule)
      .where(eq(schema.fiCouponSchedule.fiInstrumentId, inst.id))
      .orderBy(asc(schema.fiCouponSchedule.periodStart))
    : [];
  res.json({ stock, instrument: inst || null, schedule });
});

router.put("/instruments/:stockId", requireRole("admin", "pm"), async (req: AuthRequest, res) => {
  try {
    const stockId = param(req.params.stockId);
    const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, stockId));
    if (!stock) return res.status(404).json({ error: "Stock not found" });
    if (stock.instrumentType === "equity") {
      const kind = fiKindFromTicker(stock.ticker);
      if (kind) {
        await db.update(schema.stocks).set({ instrumentType: kind, updatedAt: new Date() }).where(eq(schema.stocks.id, stock.id));
      } else {
        return res.status(400).json({ error: "Stock is not a fixed-income ticker" });
      }
    }

    const result = await upsertFiInstrumentForStock(stock.id, {
      facePar: req.body.facePar != null ? num(req.body.facePar, 100) : undefined,
      couponRate: req.body.couponRate != null ? num(req.body.couponRate) : undefined,
      couponFrequency: req.body.couponFrequency,
      dayCount: req.body.dayCount || "ACT_PERIOD",
      issueDate: req.body.issueDate ?? undefined,
      maturityDate: req.body.maturityDate ?? undefined,
      shariahNotes: req.body.shariahNotes ?? undefined,
    });

    await writeAudit({
      userId: req.userId,
      action: "update",
      objectType: "fi_instrument",
      objectId: result.instrument.id,
      newValue: result.instrument,
      reason: "Update FI terms / rebuild coupon schedule",
    });

    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/instruments/:stockId/ensure", requireRole("admin", "pm"), async (req, res) => {
  const stockId = param(req.params.stockId);
  const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, stockId));
  if (!stock) return res.status(404).json({ error: "Not found" });
  const kind = fiKindFromTicker(stock.ticker) || (stock.instrumentType !== "equity" ? stock.instrumentType as any : null);
  if (!kind || kind === "equity") return res.status(400).json({ error: "Not FI" });
  await db.update(schema.stocks).set({ instrumentType: kind as any, updatedAt: new Date() }).where(eq(schema.stocks.id, stock.id));
  const result = await upsertFiInstrumentForStock(stock.id, {
    couponFrequency: defaultCouponFrequency(kind as any),
    couponRate: kind === "t_bill" ? 0 : undefined,
    dayCount: "ACT_PERIOD",
  });
  res.json(result);
});

router.get("/portfolios/:id/lots", async (req, res) => {
  const portfolioId = param(req.params.id);
  const lots = await db.select().from(schema.fiLots)
    .where(eq(schema.fiLots.portfolioId, portfolioId))
    .orderBy(desc(schema.fiLots.settlementDate));

  const enriched = [];
  for (const lot of lots) {
    const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, lot.stockId));
    const [latest] = await db.select().from(schema.fiDailyPnl)
      .where(eq(schema.fiDailyPnl.lotId, lot.id))
      .orderBy(desc(schema.fiDailyPnl.asOfDate))
      .limit(1);
    enriched.push({ ...lot, ticker: stock?.ticker, companyName: stock?.companyName, latestPnl: latest || null });
  }
  res.json(enriched);
});

router.get("/lots/:id/daily-pnl", async (req, res) => {
  const lotId = param(req.params.id);
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const rows = await db.select().from(schema.fiDailyPnl)
    .where(eq(schema.fiDailyPnl.lotId, lotId))
    .orderBy(asc(schema.fiDailyPnl.asOfDate));
  res.json(rows.filter((r) => {
    if (from && r.asOfDate < from) return false;
    if (to && r.asOfDate > to) return false;
    return true;
  }));
});

router.post("/lots/from-transaction/:txId", requireRole("admin", "pm"), async (req, res) => {
  try {
    const lot = await createLotFromBuyTransaction(param(req.params.txId));
    res.status(201).json(lot);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/lots/:id/rebuild-daily-pnl", requireRole("admin", "pm"), async (req, res) => {
  try {
    const result = await rebuildLotDailyPnl(param(req.params.id), req.body?.endDate);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/portfolios/:id/rebuild-daily-pnl", requireRole("admin", "pm"), async (req, res) => {
  try {
    const result = await rebuildPortfolioDailyPnl(param(req.params.id), req.body?.endDate);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/transactions/:txId/sync-lot", requireRole("admin", "pm"), async (req, res) => {
  try {
    const txId = param(req.params.txId);
    const [tx] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, txId));
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.type === "BUY") {
      const lot = await createLotFromBuyTransaction(tx.id);
      return res.json({ action: "created", lot });
    }
    const closed = await closeLotOnSell(tx.id);
    res.json({ action: "closed", lotIds: closed });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
