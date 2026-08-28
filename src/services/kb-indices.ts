import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { writeAudit } from "./audit.js";
import { mapBenchmarkIndex } from "./benchmark-index.js";
import { parseIndexPoints } from "./historical-sheet.js";
import { parseKbMarkdownTable } from "./kb-markdown.js";

const BATCH = 500;

/** First QERI row in KB/Market-Data/Index-Historical-Levels.md */
export const SAMPLE_QERI_DATE = "2026-06-21";
export const SAMPLE_QERI_LEVEL = 5253;

/** DSM / General Index on the year-end statement date */
export const SAMPLE_DSM_DATE = "2024-12-31";
export const SAMPLE_DSM_LEVEL = 10571.09;

export function defaultKbIndexLevelsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../KB/Market-Data/Index-Historical-Levels.md");
}

export function parseKbIndexMarkdown(markdown: string): {
  rows: { date: string; value: number; code: string; name: string; benchmark: "QERI" | "DSM" }[];
  skippedParse: number;
  skippedOtherSeries: number;
} {
  const parsed = parseIndexPoints(parseKbMarkdownTable(markdown));
  const byKey = new Map<string, { date: string; value: number; code: string; name: string; benchmark: "QERI" | "DSM" }>();
  let skippedOtherSeries = 0;
  for (const row of parsed.rows) {
    const benchmark = mapBenchmarkIndex(row.code, row.name);
    if (!benchmark) {
      skippedOtherSeries += 1;
      continue;
    }
    byKey.set(`${benchmark}|${row.date}`, { ...row, benchmark });
  }
  return {
    rows: [...byKey.values()],
    skippedParse: parsed.skipped,
    skippedOtherSeries,
  };
}

async function ensureIndex(name: string, description: string) {
  const found = await db.select().from(schema.indices).where(eq(schema.indices.name, name)).limit(1);
  if (found[0]) return found[0];
  const [created] = await db.insert(schema.indices).values({ name, description }).returning();
  return created;
}

async function insertBatches(points: { indexId: string; date: string; value: string }[]) {
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    await db.insert(schema.indexDataPoints).values(batch).onConflictDoUpdate({
      target: [schema.indexDataPoints.indexId, schema.indexDataPoints.date],
      set: { value: sql`excluded.value` },
    });
  }
}

export async function importKbIndexLevels(opts: {
  filePath?: string;
  userId?: string | null;
}): Promise<{
  filePath: string;
  parsed: number;
  skippedParse: number;
  skippedOtherSeries: number;
  upserted: number;
  qeri: number;
  dsm: number;
}> {
  const filePath = opts.filePath || defaultKbIndexLevelsPath();
  await fs.access(filePath);
  const markdown = await fs.readFile(filePath, "utf8");
  const parsed = parseKbIndexMarkdown(markdown);
  const qeri = await ensureIndex("QERI", "QE Al Rayan Islamic Index (Shariah benchmark)");
  const dsm = await ensureIndex("DSM", "QE General Index / DSM (unrestricted benchmark)");

  const points: { indexId: string; date: string; value: string }[] = [];
  let qeriCount = 0;
  let dsmCount = 0;
  for (const row of parsed.rows) {
    const indexId = row.benchmark === "QERI" ? qeri.id : dsm.id;
    if (row.benchmark === "QERI") qeriCount += 1;
    else dsmCount += 1;
    points.push({ indexId, date: row.date, value: String(row.value) });
  }
  await insertBatches(points);

  await writeAudit({
    userId: opts.userId ?? null,
    action: "update",
    objectType: "index_data_points",
    objectId: null,
    newValue: {
      source: filePath,
      parsed: parsed.rows.length,
      skippedParse: parsed.skippedParse,
      skippedOtherSeries: parsed.skippedOtherSeries,
      upserted: points.length,
      qeri: qeriCount,
      dsm: dsmCount,
    },
    reason: "Import KB CH_CURRENT_INDEX (QERI + DSM only)",
  });

  return {
    filePath,
    parsed: parsed.rows.length,
    skippedParse: parsed.skippedParse,
    skippedOtherSeries: parsed.skippedOtherSeries,
    upserted: points.length,
    qeri: qeriCount,
    dsm: dsmCount,
  };
}

async function sampleLevel(indexName: string, date: string): Promise<number | null> {
  const [row] = await db.select({
    value: schema.indexDataPoints.value,
  })
    .from(schema.indexDataPoints)
    .innerJoin(schema.indices, eq(schema.indices.id, schema.indexDataPoints.indexId))
    .where(and(eq(schema.indices.name, indexName), eq(schema.indexDataPoints.date, date)))
    .limit(1);
  return row ? Number(row.value) : null;
}

export async function kbIndexLevelsSummary() {
  const [totals] = await db.select({
    rows: sql<number>`count(*)::int`,
    minDate: sql<string>`min(${schema.indexDataPoints.date})`,
    maxDate: sql<string>`max(${schema.indexDataPoints.date})`,
  }).from(schema.indexDataPoints);

  const [qeriCount] = await db.select({
    c: sql<number>`count(*)::int`,
  })
    .from(schema.indexDataPoints)
    .innerJoin(schema.indices, eq(schema.indices.id, schema.indexDataPoints.indexId))
    .where(eq(schema.indices.name, "QERI"));

  const [dsmCount] = await db.select({
    c: sql<number>`count(*)::int`,
  })
    .from(schema.indexDataPoints)
    .innerJoin(schema.indices, eq(schema.indices.id, schema.indexDataPoints.indexId))
    .where(eq(schema.indices.name, "DSM"));

  let kbFileExists = false;
  try {
    await fs.access(defaultKbIndexLevelsPath());
    kbFileExists = true;
  } catch {
    kbFileExists = false;
  }

  return {
    rowCount: totals?.rows ?? 0,
    minDate: totals?.minDate ? String(totals.minDate).slice(0, 10) : null,
    maxDate: totals?.maxDate ? String(totals.maxDate).slice(0, 10) : null,
    qeriCount: qeriCount?.c ?? 0,
    dsmCount: dsmCount?.c ?? 0,
    kbFile: "KB/Market-Data/Index-Historical-Levels.md",
    kbFileExists,
    sampleQeri: {
      date: SAMPLE_QERI_DATE,
      value: await sampleLevel("QERI", SAMPLE_QERI_DATE),
      expected: SAMPLE_QERI_LEVEL,
    },
    sampleDsm: {
      date: SAMPLE_DSM_DATE,
      value: await sampleLevel("DSM", SAMPLE_DSM_DATE),
      expected: SAMPLE_DSM_LEVEL,
    },
  };
}
