import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq, asc, desc, and, inArray, sql, gte, lte } from "drizzle-orm";
import XLSX from "xlsx";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { upload, parseStockPriceExcel, parseBulkStockMasterExcel, cleanupUpload } from "../services/upload-parser.js";
import { sendStockPricesTemplate, sendBulkStockMasterTemplate } from "../services/template-generator.js";
import {
  rebuildAdjustedPrices,
  computeTotalReturn,
  computePerformanceMetrics,
  getFirstPriceDate,
} from "../services/adjusted-prices.js";
import { refreshStockAdtv, refreshStocksAdtv } from "../services/adtv.js";
import {
  applyCorporateActionToPortfolios,
  reverseCorporateActionApplications,
} from "../services/corporate-action-portfolio.js";
import { getPortfolioHoldings } from "../services/calculations.js";
import { param } from "../utils/params.js";
import { parseShariahGroupInput } from "../services/mandate-rules.js";

const router = Router();
router.use(authMiddleware);

const tn = (v: unknown) => Number(v ?? 0);
const ALLOWED_PAGE_SIZES = new Set([10, 25, 30, 50, 100]);

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function mapStockPriceRow(p: typeof schema.stockPrices.$inferSelect) {
  return {
    date: String(p.date).slice(0, 10),
    price: tn(p.price),
    sharePrice: p.sharePrice != null ? tn(p.sharePrice) : null,
    ask: p.ask != null ? tn(p.ask) : null,
    offer: p.offer != null ? tn(p.offer) : null,
    orderNum: p.orderNum != null ? tn(p.orderNum) : null,
    volume: p.volume != null ? tn(p.volume) : null,
    month: p.month ?? null,
    openPrice: p.openPrice != null ? tn(p.openPrice) : null,
    highPrice: p.highPrice != null ? tn(p.highPrice) : null,
    lowPrice: p.lowPrice != null ? tn(p.lowPrice) : null,
    closePrice: p.closePrice != null ? tn(p.closePrice) : null,
  };
}

function stockPriceFilterConditions(stockId: string, query: Record<string, unknown>) {
  const conditions = [eq(schema.stockPrices.stockId, stockId)];
  const exact = isoDateOrNull(query.date);
  const from = isoDateOrNull(query.from);
  const to = isoDateOrNull(query.to);
  if (exact) conditions.push(eq(schema.stockPrices.date, exact));
  if (from) conditions.push(gte(schema.stockPrices.date, from));
  if (to) conditions.push(lte(schema.stockPrices.date, to));
  return conditions;
}

router.patch("/:id/classification", requireRole("admin", "pm"), async (req, res) => {
  try {
    const id = param(req.params.id);
    const {
      shariahGroup,
      regulatoryStatus, regulatoryNotes, isTradable,
    } = req.body;
    let parsedGroup = undefined as string | null | undefined;
    if (shariahGroup !== undefined) {
      try {
        parsedGroup = parseShariahGroupInput(shariahGroup);
      } catch (e: any) {
        res.status(400).json({ error: e.message || "Invalid shariahGroup" });
        return;
      }
    }
    const [updated] = await db.update(schema.stocks).set({
      ...(parsedGroup !== undefined ? { shariahGroup: parsedGroup } : {}),
      ...(regulatoryStatus !== undefined ? { regulatoryStatus } : {}),
      ...(regulatoryNotes !== undefined ? { regulatoryNotes } : {}),
      ...(isTradable !== undefined ? { isTradable: !!isTradable } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.stocks.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/", async (_req, res) => {
  try {
    const all = await db.select().from(schema.stocks).orderBy(schema.stocks.ticker);
    const result = [];
    for (const s of all) {
      const latest = await db.select().from(schema.stockPrices).where(eq(schema.stockPrices.stockId, s.id)).orderBy(desc(schema.stockPrices.date)).limit(1);
      const prev = await db.select().from(schema.stockPrices).where(eq(schema.stockPrices.stockId, s.id)).orderBy(desc(schema.stockPrices.date)).limit(1).offset(1);
      const cp = latest.length > 0 ? tn(latest[0].price) : 0;
      const pp = prev.length > 0 ? tn(prev[0].price) : cp;
      const chg = pp > 0 ? Math.round(((cp - pp) / pp) * 1000000) / 10000 : 0;
      const spark = (await db.select().from(schema.stockPrices).where(eq(schema.stockPrices.stockId, s.id)).orderBy(desc(schema.stockPrices.date)).limit(30)).reverse().map((p) => tn(p.price));
      result.push({ ...s, currentPrice: cp, dayChangePct: chg, sparkline: spark });
    }
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Corporate Actions CRUD
// -------------------------------------------------------------------------

router.get("/:id/corporate-actions", async (req, res) => {
  try {
    const actions = await db
      .select()
      .from(schema.corporateActions)
      .where(eq(schema.corporateActions.stockId, req.params.id))
      .orderBy(desc(schema.corporateActions.actionDate));

    res.json(actions);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/corporate-actions", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const { actionDate, actionType, ratio, cashAmount } = req.body;

    if (!actionDate || !actionType) {
      res.status(400).json({ error: "actionDate and actionType are required" });
      return;
    }

    const validTypes = ["BONUS", "STOCK_SPLIT", "DIVIDEND"];
    if (!validTypes.includes(actionType)) {
      res.status(400).json({ error: "actionType must be BONUS, STOCK_SPLIT, or DIVIDEND" });
      return;
    }

    if (actionType === "BONUS" || actionType === "STOCK_SPLIT") {
      const r = tn(ratio);
      if (!ratio || r <= 0) {
        res.status(400).json({ error: "Ratio is required and must be greater than zero" });
        return;
      }
    }

    if (actionType === "DIVIDEND") {
      const c = tn(cashAmount);
      if (!cashAmount || c <= 0) {
        res.status(400).json({ error: "Cash Amount is required and must be greater than zero" });
        return;
      }
    }

    // Validation: action date cannot be before first available market price
    const firstDate = await getFirstPriceDate(stockId);
    if (firstDate && actionDate < firstDate) {
      res.status(400).json({ error: "Corporate action date cannot be earlier than the first available market price." });
      return;
    }

    // Validation: no duplicate (same ticker, date, type — amount is part of the booking identity on clients)
    const existing = await db
      .select()
      .from(schema.corporateActions)
      .where(
        and(
          eq(schema.corporateActions.stockId, stockId),
          eq(schema.corporateActions.actionDate, actionDate),
          eq(schema.corporateActions.actionType, actionType)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      res.status(400).json({ error: "Duplicate corporate action: same ticker, date, type, and amount already exists." });
      return;
    }

    const [created] = await db
      .insert(schema.corporateActions)
      .values({
        stockId,
        actionDate,
        actionType,
        ratio: ratio ? String(ratio) : null,
        cashAmount: cashAmount ? String(cashAmount) : null,
      })
      .returning();

    // Auto-rebuild adjusted prices for this ticker
    await rebuildAdjustedPrices(stockId);
    const portfolioImpact = await applyCorporateActionToPortfolios(created.id);

    res.status(201).json({ ...created, portfolioImpact });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.put("/:id/corporate-actions/:caid", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const caid = param(req.params.caid);
    const { actionDate, actionType, ratio, cashAmount } = req.body;

    const existingCa = await db
      .select()
      .from(schema.corporateActions)
      .where(eq(schema.corporateActions.id, caid))
      .limit(1);

    if (existingCa.length === 0) {
      res.status(404).json({ error: "Corporate action not found" });
      return;
    }

    if (!actionDate || !actionType) {
      res.status(400).json({ error: "actionDate and actionType are required" });
      return;
    }

    const validTypes = ["BONUS", "STOCK_SPLIT", "DIVIDEND"];
    if (!validTypes.includes(actionType)) {
      res.status(400).json({ error: "actionType must be BONUS, STOCK_SPLIT, or DIVIDEND" });
      return;
    }

    if (actionType === "BONUS" || actionType === "STOCK_SPLIT") {
      const r = tn(ratio);
      if (!ratio || r <= 0) {
        res.status(400).json({ error: "Ratio is required and must be greater than zero" });
        return;
      }
    }

    if (actionType === "DIVIDEND") {
      const c = tn(cashAmount);
      if (!cashAmount || c <= 0) {
        res.status(400).json({ error: "Cash Amount is required and must be greater than zero" });
        return;
      }
    }

    const firstDate = await getFirstPriceDate(stockId);
    if (firstDate && actionDate < firstDate) {
      res.status(400).json({
        error: "Corporate action date cannot be earlier than the first available market price.",
      });
      return;
    }

    // Check for duplicate (excluding current record)
    const duplicate = await db
      .select()
      .from(schema.corporateActions)
      .where(
        and(
          eq(schema.corporateActions.stockId, stockId),
          eq(schema.corporateActions.actionDate, actionDate),
          eq(schema.corporateActions.actionType, actionType)
        )
      )
      .limit(1);

    if (duplicate.length > 0 && duplicate[0].id !== caid) {
      res.status(400).json({
        error: "Duplicate corporate action: same ticker, date, type, and amount already exists.",
      });
      return;
    }

    const [updated] = await db
      .update(schema.corporateActions)
      .set({
        actionDate,
        actionType,
        ratio: actionType === "DIVIDEND" ? null : ratio ? String(ratio) : null,
        cashAmount: actionType === "DIVIDEND" ? (cashAmount ? String(cashAmount) : null) : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.corporateActions.id, caid))
      .returning();

    await rebuildAdjustedPrices(stockId);
    // Reverse old portfolio effects, then re-apply with updated CA params
    await reverseCorporateActionApplications(caid);
    const portfolioImpact = await applyCorporateActionToPortfolios(caid);

    res.json({ ...updated, portfolioImpact });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id/corporate-actions/:caid", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const caid = param(req.params.caid);

    const existing = await db
      .select()
      .from(schema.corporateActions)
      .where(eq(schema.corporateActions.id, caid))
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: "Corporate action not found" });
      return;
    }

    // Reverse cash + delete application rows so holdings/cash rebalance before CA removal
    const reversed = await reverseCorporateActionApplications(caid);
    await db.delete(schema.corporateActions).where(eq(schema.corporateActions.id, caid));

    await rebuildAdjustedPrices(stockId);

    res.json({ success: true, portfolioImpact: reversed });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Price history (filtered / paginated / export)
// -------------------------------------------------------------------------

router.get("/:id/prices/export", async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const stock = await db.select({ ticker: schema.stocks.ticker }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (stock.length === 0) { res.status(404).json({ error: "Not found" }); return; }

    const ticker = stock[0].ticker;
    const exportAll = String(req.query.all ?? "") === "1" || String(req.query.all ?? "").toLowerCase() === "true";
    const query = exportAll ? {} : (req.query as Record<string, unknown>);
    const conditions = stockPriceFilterConditions(stockId, query);
    const rows = await db
      .select()
      .from(schema.stockPrices)
      .where(and(...conditions))
      .orderBy(desc(schema.stockPrices.date));

    const exportRows = rows.map((p) => {
      const m = mapStockPriceRow(p);
      return {
        Date: m.date,
        Open: m.openPrice,
        High: m.highPrice,
        Low: m.lowPrice,
        Close: m.closePrice ?? m.price,
        Share: m.sharePrice,
        Ask: m.ask,
        Offer: m.offer,
        Volume: m.volume,
        Orders: m.orderNum,
        Month: m.month,
      };
    });

    const today = new Date().toISOString().slice(0, 10);
    const exact = isoDateOrNull(query.date);
    const fromFilter = exact ?? isoDateOrNull(query.from);
    const toFilter = exact ?? isoDateOrNull(query.to);
    const dataNewest = rows[0] ? String(rows[0].date).slice(0, 10) : null;
    const dataOldest = rows.length ? String(rows[rows.length - 1].date).slice(0, 10) : null;
    const fromDate = fromFilter || dataOldest || today;
    const toDate = toFilter || dataNewest || today;

    const safeSheet = (name: string) => name.replace(/[\\/?*[\]]/g, "-").slice(0, 31);
    let filename: string;
    let sheetName: string;
    if (exportAll) {
      sheetName = safeSheet(`${ticker} - all values - ${today}`);
      filename = `${ticker} - all values - ${today}.xlsx`;
    } else {
      sheetName = safeSheet(`${ticker} from ${fromDate} to ${toDate}`);
      filename = `${ticker} from ${fromDate} to ${toDate}.xlsx`;
    }

    const ws = XLSX.utils.json_to_sheet(exportRows);
    ws["!cols"] = Array.from({ length: 11 }, () => ({ wch: 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id/prices", async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const stock = await db.select({ id: schema.stocks.id }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (stock.length === 0) { res.status(404).json({ error: "Not found" }); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const rawSize = parseInt(String(req.query.pageSize ?? "10"), 10) || 10;
    const pageSize = ALLOWED_PAGE_SIZES.has(rawSize) ? rawSize : 10;
    const conditions = stockPriceFilterConditions(stockId, req.query as Record<string, unknown>);
    const where = and(...conditions);

    const [countRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.stockPrices)
      .where(where);
    const total = countRow?.c ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    const rows = await db
      .select()
      .from(schema.stockPrices)
      .where(where)
      .orderBy(desc(schema.stockPrices.date))
      .limit(pageSize)
      .offset(offset);

    res.json({
      data: rows.map(mapStockPriceRow),
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
      },
      filters: {
        date: isoDateOrNull(req.query.date),
        from: isoDateOrNull(req.query.from),
        to: isoDateOrNull(req.query.to),
      },
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

function normalizeStockPriceBody(body: Record<string, unknown>) {
  const date = isoDateOrNull(body.date);
  const close = body.closePrice != null ? Number(body.closePrice) : null;
  const price = body.price != null ? Number(body.price) : close;
  if (!date || price == null || !Number.isFinite(price) || price <= 0) {
    return { error: "date and a positive price/closePrice are required" as const };
  }
  const opt = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : null;
  };
  return {
    date,
    row: {
      date,
      price: String(price),
      sharePrice: opt(body.sharePrice),
      ask: opt(body.ask),
      offer: opt(body.offer),
      orderNum: opt(body.orderNum),
      volume: opt(body.volume),
      month: typeof body.month === "string" ? body.month : null,
      openPrice: opt(body.openPrice),
      highPrice: opt(body.highPrice),
      lowPrice: opt(body.lowPrice),
      closePrice: opt(body.closePrice ?? price),
    },
  };
}

router.post("/:id/prices", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const stock = await db.select({ id: schema.stocks.id }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (!stock[0]) { res.status(404).json({ error: "Not found" }); return; }
    const parsed = normalizeStockPriceBody(req.body || {});
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

    const existing = await db.select({ date: schema.stockPrices.date })
      .from(schema.stockPrices)
      .where(and(eq(schema.stockPrices.stockId, stockId), eq(schema.stockPrices.date, parsed.date)))
      .limit(1);
    if (existing[0]) {
      res.status(409).json({ error: `Price already exists for ${parsed.date}. Use edit instead.` });
      return;
    }

    await batchInsertPrices([{ stockId, ...parsed.row }]);
    await rebuildAdjustedPrices(stockId);
    await refreshStockAdtv(stockId);
    res.status(201).json({ success: true, ...mapStockPriceRow({
      id: "",
      stockId,
      ...parsed.row,
      sharePrice: parsed.row.sharePrice,
      ask: parsed.row.ask,
      offer: parsed.row.offer,
      orderNum: parsed.row.orderNum,
      volume: parsed.row.volume,
      month: parsed.row.month,
      openPrice: parsed.row.openPrice,
      highPrice: parsed.row.highPrice,
      lowPrice: parsed.row.lowPrice,
      closePrice: parsed.row.closePrice,
    } as any) });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.put("/:id/prices/:date", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const date = isoDateOrNull(req.params.date);
    if (!date) { res.status(400).json({ error: "Invalid date" }); return; }
    const parsed = normalizeStockPriceBody({ ...req.body, date });
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

    const existing = await db.select().from(schema.stockPrices)
      .where(and(eq(schema.stockPrices.stockId, stockId), eq(schema.stockPrices.date, date)))
      .limit(1);
    if (!existing[0]) { res.status(404).json({ error: "Data point not found" }); return; }

    await batchInsertPrices([{ stockId, ...parsed.row }]);
    await rebuildAdjustedPrices(stockId);
    await refreshStockAdtv(stockId);
    res.json({ success: true, date, price: Number(parsed.row.price) });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id/prices/:date", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const date = isoDateOrNull(req.params.date);
    if (!date) { res.status(400).json({ error: "Invalid date" }); return; }
    const deleted = await db.delete(schema.stockPrices)
      .where(and(eq(schema.stockPrices.stockId, stockId), eq(schema.stockPrices.date, date)))
      .returning({ date: schema.stockPrices.date });
    if (!deleted[0]) { res.status(404).json({ error: "Data point not found" }); return; }
    await rebuildAdjustedPrices(stockId);
    await refreshStockAdtv(stockId);
    res.json({ success: true, deleted: date });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/upload/preview", requireRole("admin", "pm"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const stockId = param(req.params.id);
    const stock = await db.select({ id: schema.stocks.id, ticker: schema.stocks.ticker }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (!stock[0]) { cleanupUpload(req.file.path); res.status(404).json({ error: "Not found" }); return; }

    const rows = parseStockPriceExcel(req.file.path);
    cleanupUpload(req.file.path);
    if (rows.length === 0) { res.status(400).json({ error: "No valid data" }); return; }

    const byDate = new Map<string, number>();
    for (const r of rows) byDate.set(r.date, r.price);
    const dates = [...byDate.keys()];
    const existing = dates.length
      ? await db.select().from(schema.stockPrices).where(and(
          eq(schema.stockPrices.stockId, stockId),
          inArray(schema.stockPrices.date, dates),
        ))
      : [];
    const existingByDate = new Map(existing.map((e) => [String(e.date).slice(0, 10), e]));

    const conflicts = [];
    const newRows = [];
    for (const [date, price] of byDate) {
      const cur = existingByDate.get(date);
      const incoming = { date, price, closePrice: price };
      if (cur) {
        conflicts.push({
          date,
          current: { date, price: tn(cur.price), closePrice: cur.closePrice != null ? tn(cur.closePrice) : tn(cur.price) },
          incoming,
        });
      } else {
        newRows.push(incoming);
      }
    }

    res.json({
      kind: "stock",
      ticker: stock[0].ticker,
      total: byDate.size,
      newCount: newRows.length,
      conflictCount: conflicts.length,
      newRows,
      conflicts,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/upload/commit", requireRole("admin", "pm"), async (req, res) => {
  try {
    const stockId = param(req.params.id);
    const stock = await db.select({ id: schema.stocks.id }).from(schema.stocks).where(eq(schema.stocks.id, stockId)).limit(1);
    if (!stock[0]) { res.status(404).json({ error: "Not found" }); return; }

    const { newRows = [], overwriteRows = [] } = req.body as {
      newRows?: { date: string; price: number }[];
      overwriteRows?: { date: string; price: number }[];
    };
    const toWrite = [...newRows, ...overwriteRows]
      .filter((r) => r?.date && Number(r.price) > 0)
      .map((r) => ({
        stockId,
        date: String(r.date).slice(0, 10),
        price: String(r.price),
        closePrice: String(r.price),
      }));

    if (toWrite.length === 0) {
      res.status(400).json({ error: "No rows selected to write" });
      return;
    }

    await batchInsertPrices(toWrite);
    await rebuildAdjustedPrices(stockId);
    await refreshStockAdtv(stockId);
    res.json({
      count: toWrite.length,
      inserted: newRows.length,
      overwritten: overwriteRows.length,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Adjusted Prices & Total Return
// -------------------------------------------------------------------------

router.get("/:id/adjusted-prices", async (req, res) => {
  try {
    const adjPrices = await db
      .select()
      .from(schema.adjustedPrices)
      .where(eq(schema.adjustedPrices.stockId, req.params.id))
      .orderBy(asc(schema.adjustedPrices.tradeDate));

    res.json(adjPrices.map((p) => ({
      date: p.tradeDate,
      rawClose: tn(p.rawClose),
      adjustedClose: tn(p.adjustedClose),
      adjustmentFactor: tn(p.adjustmentFactor),
    })));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id/total-return", async (req, res) => {
  try {
    const triData = await computeTotalReturn(req.params.id);
    res.json(triData);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id/performance-metrics", async (req, res) => {
  try {
    const metrics = await computePerformanceMetrics(req.params.id);
    res.json(metrics);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/rebuild-adjusted-prices", requireRole("admin", "pm"), async (req, res) => {
  try {
    await rebuildAdjustedPrices(param(req.params.id));
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Stock Detail
// -------------------------------------------------------------------------

router.get("/:id", async (req, res) => {
  try {
    const stock = await db.select().from(schema.stocks).where(eq(schema.stocks.id, req.params.id)).limit(1);
    if (stock.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    const prices = await db.select().from(schema.stockPrices).where(eq(schema.stockPrices.stockId, req.params.id)).orderBy(asc(schema.stockPrices.date));
    const lp = prices.length > 0 ? tn(prices[prices.length - 1].price) : 0;
    const pp = prices.length > 1 ? tn(prices[prices.length - 2].price) : lp;
    const chg = pp > 0 ? Math.round(((lp - pp) / pp) * 1000000) / 10000 : 0;

    let holdingInfo = null;
    const portfolioId = req.query.portfolioId as string | undefined;
    if (portfolioId) {
      const holdings = await getPortfolioHoldings(portfolioId);
      const h = holdings.find((x) => x.stockId === req.params.id);
      if (h) {
        holdingInfo = {
          quantity: h.quantity,
          avgCost: h.avgCost,
          totalCost: h.totalCost,
          currentValue: h.currentValue,
          gainLossValue: h.gainLossValue,
          gainLossPct: h.gainLossPct,
        };
      }
    }

    // Corporate actions
    const corporateActions = await db
      .select()
      .from(schema.corporateActions)
      .where(eq(schema.corporateActions.stockId, req.params.id))
      .orderBy(desc(schema.corporateActions.actionDate));

    const caMapped = corporateActions.map((ca) => ({
      id: ca.id,
      ticker: stock[0].ticker,
      actionDate: ca.actionDate,
      actionType: ca.actionType,
      ratio: ca.ratio ? tn(ca.ratio) : null,
      cashAmount: ca.cashAmount ? tn(ca.cashAmount) : null,
      createdAt: ca.createdAt,
    }));

    // Adjusted price history
    const adjPrices = await db
      .select()
      .from(schema.adjustedPrices)
      .where(eq(schema.adjustedPrices.stockId, req.params.id))
      .orderBy(asc(schema.adjustedPrices.tradeDate));

    const adjustedPriceHistory = adjPrices.map((p) => ({
      date: p.tradeDate,
      rawClose: tn(p.rawClose),
      adjustedClose: tn(p.adjustedClose),
      adjustmentFactor: tn(p.adjustmentFactor),
    }));

    // Total Return Index
    const totalReturnIndex = await computeTotalReturn(req.params.id);

    // Performance metrics
    const performanceMetrics = await computePerformanceMetrics(req.params.id);

    res.json({
      ...stock[0],
      avgDailyTradedValue: stock[0].avgDailyTradedValue != null ? tn(stock[0].avgDailyTradedValue) : null,
      latestPrice: lp,
      dayChangePct: chg,
      // Chart series only — full market fields come from GET /:id/prices
      priceHistory: prices.map((p) => ({
        date: String(p.date).slice(0, 10),
        price: tn(p.price),
      })),
      holdingInfo,
      corporateActions: caMapped,
      adjustedPriceHistory,
      totalReturnIndex,
      performanceMetrics,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Create / Delete Stock
// -------------------------------------------------------------------------

router.post("/", requireRole("admin", "pm"), async (req, res) => {
  try {
    let shariahGroup: string | null = null;
    try {
      shariahGroup = parseShariahGroupInput(req.body.shariahGroup);
    } catch (e: any) {
      res.status(400).json({ error: e.message || "Invalid shariahGroup" });
      return;
    }
    const [created] = await db.insert(schema.stocks).values({
      ticker: req.body.ticker,
      companyName: req.body.companyName,
      sector: req.body.sector,
      shariahGroup,
      regulatoryStatus: req.body.regulatoryStatus || "clear",
      avgDailyTradedValue: req.body.avgDailyTradedValue != null ? String(req.body.avgDailyTradedValue) : null,
      isTradable: req.body.isTradable !== false,
      regulatoryNotes: req.body.regulatoryNotes || null,
    }).returning();
    res.status(201).json(created);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try { await db.delete(schema.stocks).where(eq(schema.stocks.id, param(req.params.id))); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// File Upload
// -------------------------------------------------------------------------

router.post("/:id/upload", requireRole("admin", "pm"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const stockId = req.params.id as string;
    console.log(`[stocks] Uploading prices for stock ${stockId} — parsing ${req.file.originalname}...`);
    const rows = parseStockPriceExcel(req.file.path);
    if (rows.length === 0) { res.status(400).json({ error: "No valid data" }); cleanupUpload(req.file.path); return; }
    console.log(`[stocks] Parsed ${rows.length} price rows`);
    const priceRows = rows.map((r) => ({ stockId, date: r.date, price: String(r.price) }));
    await batchInsertPrices(priceRows);
    cleanupUpload(req.file.path);

    // Rebuild adjusted prices after new raw prices are uploaded
    await rebuildAdjustedPrices(stockId);
    await refreshStockAdtv(stockId);

    console.log(`[stocks] Upload complete — ${rows.length} prices for stock ${stockId}`);
    res.json({ count: rows.length });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/template/download", (_req, res) => {
  sendStockPricesTemplate(res);
});

router.get("/bulk-template/download", (_req, res) => {
  sendBulkStockMasterTemplate(res);
});

type PriceInsertRow = {
  stockId: string;
  date: string;
  price: string;
  sharePrice?: string | null;
  ask?: string | null;
  offer?: string | null;
  orderNum?: string | null;
  volume?: string | null;
  month?: string | null;
  openPrice?: string | null;
  highPrice?: string | null;
  lowPrice?: string | null;
  closePrice?: string | null;
};

function toNumStr(v: number | null | undefined): string | null {
  return v == null || Number.isNaN(v) ? null : String(v);
}

async function batchInsertPrices(rows: PriceInsertRow[]) {
  const chunkSize = 200;
  const totalChunks = Math.ceil(rows.length / chunkSize);
  console.log(`[stocks] Batch inserting ${rows.length} prices in ${totalChunks} chunk(s)...`);
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(schema.stockPrices).values(chunk).onConflictDoUpdate({
      target: [schema.stockPrices.stockId, schema.stockPrices.date],
      set: {
        price: sql`excluded.price`,
        sharePrice: sql`excluded.share_price`,
        ask: sql`excluded.ask`,
        offer: sql`excluded.offer`,
        orderNum: sql`excluded.order_num`,
        volume: sql`excluded.volume`,
        month: sql`excluded.month`,
        openPrice: sql`excluded.open_price`,
        highPrice: sql`excluded.high_price`,
        lowPrice: sql`excluded.low_price`,
        closePrice: sql`excluded.close_price`,
      },
    });
    console.log(`[stocks] Upserted chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} (${chunk.length} rows)`);
  }
  console.log(`[stocks] Batch insert complete`);
}

router.post("/bulk-upload", requireRole("admin", "pm"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    console.log(`[stocks] Bulk upload — parsing ${req.file.originalname}...`);
    const rows = parseBulkStockMasterExcel(req.file.path);
    if (rows.length === 0) { res.status(400).json({ error: "No valid data found. Expected columns: TICKER_ID, PR_PRICE_DATE, PR_C_PRICE" }); cleanupUpload(req.file.path); return; }

    const tickers = [...new Set(rows.map((r) => r.ticker))];
    console.log(`[stocks] Parsed ${rows.length} rows across ${tickers.length} unique ticker(s)`);
    const existingStocks = await db.select().from(schema.stocks).where(inArray(schema.stocks.ticker, tickers));
    const existingTickers = new Set(existingStocks.map((s) => s.ticker));
    const newTickers = tickers.filter((t) => !existingTickers.has(t));

    if (newTickers.length > 0) {
      console.log(`[stocks] Creating ${newTickers.length} new stock(s)...`);
      for (let i = 0; i < newTickers.length; i += 200) {
        const chunk = newTickers.slice(i, i + 200);
        await db.insert(schema.stocks).values(chunk.map((t) => ({ ticker: t, companyName: t, sector: "Qatar" })));
      }
    }

    const allStocks = await db.select().from(schema.stocks).where(inArray(schema.stocks.ticker, tickers));
    const tickerToId = new Map(allStocks.map((s) => [s.ticker, s.id]));

    const priceRows: PriceInsertRow[] = rows
      .filter((r) => tickerToId.has(r.ticker))
      .map((r) => ({
        stockId: tickerToId.get(r.ticker)!,
        date: r.date,
        price: String(r.price),
        sharePrice: toNumStr(r.sharePrice),
        ask: toNumStr(r.ask),
        offer: toNumStr(r.offer),
        orderNum: toNumStr(r.orderNum),
        volume: toNumStr(r.volume),
        month: r.month,
        openPrice: toNumStr(r.openPrice),
        highPrice: toNumStr(r.highPrice),
        lowPrice: toNumStr(r.lowPrice),
        closePrice: toNumStr(r.closePrice),
      }));

    if (priceRows.length > 0) {
      await batchInsertPrices(priceRows);
    }

    const affectedStocks = [...new Set(priceRows.map((r) => r.stockId))];
    console.log(`[stocks] Rebuilding adjusted prices for ${affectedStocks.length} stock(s)...`);
    for (const stockId of affectedStocks) {
      await rebuildAdjustedPrices(stockId);
    }
    console.log(`[stocks] Refreshing ADTV from market volume for ${affectedStocks.length} stock(s)...`);
    await refreshStocksAdtv(affectedStocks);

    cleanupUpload(req.file.path);
    console.log(`[stocks] Bulk upload complete — ${priceRows.length} prices, ${newTickers.length} stocks created`);
    res.json({
      count: priceRows.length,
      stocksCreated: newTickers.length,
      stocksFound: existingTickers.size,
      tickers: newTickers,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
