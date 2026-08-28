import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq, asc, desc, and, inArray, sql, gte, lte } from "drizzle-orm";
import XLSX from "xlsx";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { upload, parseIndexExcel, cleanupUpload, type IndexDataPointRow } from "../services/upload-parser.js";
import { sendIndexDataTemplate } from "../services/template-generator.js";
import { param } from "../utils/params.js";

const router = Router();
router.use(authMiddleware);

const ALLOWED_PAGE_SIZES = new Set([10, 25, 30, 50, 100]);

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function optNumStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

function mapIndexPoint(p: typeof schema.indexDataPoints.$inferSelect) {
  return {
    id: p.id,
    indexId: p.indexId,
    date: String(p.date).slice(0, 10),
    value: Number(p.value),
    openValue: p.openValue != null ? Number(p.openValue) : null,
    highValue: p.highValue != null ? Number(p.highValue) : null,
    lowValue: p.lowValue != null ? Number(p.lowValue) : null,
  };
}

function indexDataPointFilterConditions(indexId: string, query: Record<string, unknown>) {
  const conditions = [eq(schema.indexDataPoints.indexId, indexId)];
  const exact = isoDateOrNull(query.date);
  const from = isoDateOrNull(query.from);
  const to = isoDateOrNull(query.to);
  if (exact) conditions.push(eq(schema.indexDataPoints.date, exact));
  if (from) conditions.push(gte(schema.indexDataPoints.date, from));
  if (to) conditions.push(lte(schema.indexDataPoints.date, to));
  return conditions;
}

type IndexInsertRow = {
  indexId: string;
  date: string;
  value: string;
  openValue: string | null;
  highValue: string | null;
  lowValue: string | null;
};

function toInsertRow(indexId: string, r: IndexDataPointRow | {
  date: string;
  value: number;
  openValue?: number | null;
  highValue?: number | null;
  lowValue?: number | null;
}): IndexInsertRow {
  return {
    indexId,
    date: String(r.date).slice(0, 10),
    value: String(r.value),
    openValue: optNumStr(r.openValue),
    highValue: optNumStr(r.highValue),
    lowValue: optNumStr(r.lowValue),
  };
}

async function upsertIndexPoints(rows: IndexInsertRow[]) {
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(schema.indexDataPoints).values(chunk).onConflictDoUpdate({
      target: [schema.indexDataPoints.indexId, schema.indexDataPoints.date],
      set: {
        value: sql`excluded.value`,
        openValue: sql`excluded.open_value`,
        highValue: sql`excluded.high_value`,
        lowValue: sql`excluded.low_value`,
      },
    });
  }
}

router.get("/template/download", (_req, res) => {
  sendIndexDataTemplate(res);
});

router.get("/", async (_req, res) => {
  try {
    const all = await db.select().from(schema.indices).orderBy(schema.indices.createdAt);
    const result = [];
    for (const idx of all) {
      const latest = await db.select().from(schema.indexDataPoints).where(eq(schema.indexDataPoints.indexId, idx.id)).orderBy(desc(schema.indexDataPoints.date)).limit(1);
      const prev = await db.select().from(schema.indexDataPoints).where(eq(schema.indexDataPoints.indexId, idx.id)).orderBy(desc(schema.indexDataPoints.date)).limit(1).offset(1);
      const cv = latest.length > 0 ? Number(latest[0].value) : 0;
      const pv = prev.length > 0 ? Number(prev[0].value) : cv;
      const chg = pv > 0 ? Math.round(((cv - pv) / pv) * 1000000) / 10000 : 0;
      const spark = (await db.select().from(schema.indexDataPoints).where(eq(schema.indexDataPoints.indexId, idx.id)).orderBy(desc(schema.indexDataPoints.date)).limit(30)).reverse().map((d) => Number(d.value));
      result.push({ ...idx, currentValue: cv, dayChangePct: chg, sparkline: spark });
    }
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const idx = await db.select().from(schema.indices).where(eq(schema.indices.id, param(req.params.id))).limit(1);
    if (idx.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    const data = await db.select().from(schema.indexDataPoints).where(eq(schema.indexDataPoints.indexId, param(req.params.id))).orderBy(asc(schema.indexDataPoints.date));
    res.json({ ...idx[0], dataPoints: data.map(mapIndexPoint) });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/", requireRole("admin", "pm"), async (req, res) => {
  try {
    const [created] = await db.insert(schema.indices).values({ name: req.body.name, description: req.body.description }).returning();
    res.status(201).json(created);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try { await db.delete(schema.indices).where(eq(schema.indices.id, param(req.params.id))); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

// -------------------------------------------------------------------------
// Data points (filtered / paginated / export)
// -------------------------------------------------------------------------

router.get("/:id/data-points/export", async (req, res) => {
  try {
    const indexId = param(req.params.id);
    const idx = await db.select({ name: schema.indices.name }).from(schema.indices).where(eq(schema.indices.id, indexId)).limit(1);
    if (idx.length === 0) { res.status(404).json({ error: "Not found" }); return; }

    const name = idx[0].name;
    const exportAll = String(req.query.all ?? "") === "1" || String(req.query.all ?? "").toLowerCase() === "true";
    const query = exportAll ? {} : (req.query as Record<string, unknown>);
    const conditions = indexDataPointFilterConditions(indexId, query);
    const rows = await db
      .select()
      .from(schema.indexDataPoints)
      .where(and(...conditions))
      .orderBy(desc(schema.indexDataPoints.date));

    const exportRows = rows.map((p) => {
      const m = mapIndexPoint(p);
      return {
        Date: m.date,
        Open: m.openValue,
        High: m.highValue,
        Low: m.lowValue,
        Close: m.value,
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

    const safeName = name.replace(/[\\/?*[\]]/g, "-").slice(0, 40);
    const safeSheet = (n: string) => n.replace(/[\\/?*[\]]/g, "-").slice(0, 31);
    let filename: string;
    let sheetName: string;
    if (exportAll) {
      sheetName = safeSheet(`${safeName} - all - ${today}`);
      filename = `${safeName} - all values - ${today}.xlsx`;
    } else {
      sheetName = safeSheet(`${safeName} from ${fromDate} to ${toDate}`);
      filename = `${safeName} from ${fromDate} to ${toDate}.xlsx`;
    }

    const ws = XLSX.utils.json_to_sheet(exportRows);
    ws["!cols"] = Array.from({ length: 5 }, () => ({ wch: 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id/data-points", async (req, res) => {
  try {
    const indexId = param(req.params.id);
    const idx = await db.select({ id: schema.indices.id }).from(schema.indices).where(eq(schema.indices.id, indexId)).limit(1);
    if (idx.length === 0) { res.status(404).json({ error: "Not found" }); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const rawSize = parseInt(String(req.query.pageSize ?? "10"), 10) || 10;
    const pageSize = ALLOWED_PAGE_SIZES.has(rawSize) ? rawSize : 10;
    const conditions = indexDataPointFilterConditions(indexId, req.query as Record<string, unknown>);
    const where = and(...conditions);

    const [countRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.indexDataPoints)
      .where(where);
    const total = countRow?.c ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    const rows = await db
      .select()
      .from(schema.indexDataPoints)
      .where(where)
      .orderBy(desc(schema.indexDataPoints.date))
      .limit(pageSize)
      .offset(offset);

    res.json({
      data: rows.map(mapIndexPoint),
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

router.post("/:id/data-points", requireRole("admin", "pm"), async (req, res) => {
  try {
    const indexId = param(req.params.id);
    const date = isoDateOrNull(req.body?.date);
    const value = Number(req.body?.value);
    if (!date || !Number.isFinite(value) || value <= 0) {
      res.status(400).json({ error: "date and a positive close value are required" });
      return;
    }
    const idx = await db.select({ id: schema.indices.id }).from(schema.indices).where(eq(schema.indices.id, indexId)).limit(1);
    if (!idx[0]) { res.status(404).json({ error: "Not found" }); return; }

    const existing = await db.select({ date: schema.indexDataPoints.date })
      .from(schema.indexDataPoints)
      .where(and(eq(schema.indexDataPoints.indexId, indexId), eq(schema.indexDataPoints.date, date)))
      .limit(1);
    if (existing[0]) {
      res.status(409).json({ error: `Data point already exists for ${date}. Use edit instead.` });
      return;
    }

    const [created] = await db.insert(schema.indexDataPoints).values({
      indexId,
      date,
      value: String(value),
      openValue: optNumStr(req.body?.openValue),
      highValue: optNumStr(req.body?.highValue),
      lowValue: optNumStr(req.body?.lowValue),
    }).returning();
    res.status(201).json(mapIndexPoint(created));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.put("/:id/data-points/:date", requireRole("admin", "pm"), async (req, res) => {
  try {
    const indexId = param(req.params.id);
    const date = isoDateOrNull(req.params.date);
    const value = Number(req.body?.value);
    if (!date || !Number.isFinite(value) || value <= 0) {
      res.status(400).json({ error: "date and a positive close value are required" });
      return;
    }
    const [updated] = await db.update(schema.indexDataPoints)
      .set({
        value: String(value),
        openValue: optNumStr(req.body?.openValue),
        highValue: optNumStr(req.body?.highValue),
        lowValue: optNumStr(req.body?.lowValue),
      })
      .where(and(eq(schema.indexDataPoints.indexId, indexId), eq(schema.indexDataPoints.date, date)))
      .returning();
    if (!updated) { res.status(404).json({ error: "Data point not found" }); return; }
    res.json(mapIndexPoint(updated));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id/data-points/:date", requireRole("admin", "pm"), async (req, res) => {
  try {
    const indexId = param(req.params.id);
    const date = isoDateOrNull(req.params.date);
    if (!date) { res.status(400).json({ error: "Invalid date" }); return; }
    const deleted = await db.delete(schema.indexDataPoints)
      .where(and(eq(schema.indexDataPoints.indexId, indexId), eq(schema.indexDataPoints.date, date)))
      .returning({ date: schema.indexDataPoints.date });
    if (!deleted[0]) { res.status(404).json({ error: "Data point not found" }); return; }
    res.json({ success: true, deleted: date });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/upload/preview", requireRole("admin", "pm"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const indexId = param(req.params.id);
    const idx = await db.select().from(schema.indices).where(eq(schema.indices.id, indexId)).limit(1);
    if (!idx[0]) { cleanupUpload(req.file.path); res.status(404).json({ error: "Not found" }); return; }

    const rows = parseIndexExcel(req.file.path);
    cleanupUpload(req.file.path);
    if (rows.length === 0) { res.status(400).json({ error: "No valid data" }); return; }

    const byDate = new Map<string, IndexDataPointRow>();
    for (const r of rows) byDate.set(r.date, r);
    const dates = [...byDate.keys()];
    const existing = dates.length
      ? await db.select().from(schema.indexDataPoints).where(and(
          eq(schema.indexDataPoints.indexId, indexId),
          inArray(schema.indexDataPoints.date, dates),
        ))
      : [];
    const existingByDate = new Map(existing.map((e) => [String(e.date).slice(0, 10), e]));

    const conflicts = [];
    const newRows = [];
    for (const [date, incoming] of byDate) {
      const cur = existingByDate.get(date);
      if (cur) {
        conflicts.push({
          date,
          current: mapIndexPoint(cur),
          incoming,
        });
      } else {
        newRows.push(incoming);
      }
    }

    res.json({
      kind: "index",
      name: idx[0].name,
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
    const indexId = param(req.params.id);
    const idx = await db.select({ id: schema.indices.id }).from(schema.indices).where(eq(schema.indices.id, indexId)).limit(1);
    if (!idx[0]) { res.status(404).json({ error: "Not found" }); return; }

    const { newRows = [], overwriteRows = [] } = req.body as {
      newRows?: IndexDataPointRow[];
      overwriteRows?: IndexDataPointRow[];
    };
    const toWrite = [...newRows, ...overwriteRows]
      .filter((r) => r?.date && Number(r.value) > 0)
      .map((r) => toInsertRow(indexId, r));

    if (toWrite.length === 0) {
      res.status(400).json({ error: "No rows selected to write" });
      return;
    }

    await upsertIndexPoints(toWrite);
    res.json({
      count: toWrite.length,
      inserted: newRows.length,
      overwritten: overwriteRows.length,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/:id/upload", requireRole("admin", "pm"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const rows = parseIndexExcel(req.file.path);
    if (rows.length === 0) { res.status(400).json({ error: "No valid data" }); cleanupUpload(req.file.path); return; }
    const indexId = param(req.params.id);
    await upsertIndexPoints(rows.map((r) => toInsertRow(indexId, r)));
    cleanupUpload(req.file.path);
    res.json({ count: rows.length });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
