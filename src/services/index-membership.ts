import { db, schema } from "../db/connection.js";
import { eq, desc, and, inArray, gt } from "drizzle-orm";

type MembershipFlag = "isQeriMember" | "isDsmMember";

function flagForIndexName(name: string): MembershipFlag | null {
  const n = name.trim().toUpperCase();
  if (n === "QERI" || n.includes("QERI") || /AL RAYAN ISLAMIC/i.test(name)) return "isQeriMember";
  if (n === "DSM" || n.includes("DSM") || /GENERAL INDEX/i.test(name) || /QATAR EXCHANGE/i.test(name)) {
    return "isDsmMember";
  }
  return null;
}

async function memberStockIdsForIndex(indexId: string): Promise<Set<string>> {
  const latest = await db
    .select({ effectiveDate: schema.indexConstituents.effectiveDate })
    .from(schema.indexConstituents)
    .where(eq(schema.indexConstituents.indexId, indexId))
    .orderBy(desc(schema.indexConstituents.effectiveDate))
    .limit(1);

  if (!latest[0]) return new Set();

  const rows = await db
    .select({ stockId: schema.indexConstituents.stockId })
    .from(schema.indexConstituents)
    .where(and(
      eq(schema.indexConstituents.indexId, indexId),
      eq(schema.indexConstituents.effectiveDate, latest[0].effectiveDate),
      gt(schema.indexConstituents.weight, "0"),
    ));

  return new Set(rows.map((r) => r.stockId));
}

/**
 * Derive stock isQeriMember / isDsmMember from the latest constituent snapshot
 * of QERI / DSM. Constituents are the source of truth; flags are a cached mirror.
 * A stock may be a member of both indices.
 */
export async function syncIndexMembershipFlags(): Promise<{
  qeriMembers: number;
  dsmMembers: number;
}> {
  const indices = await db.select({ id: schema.indices.id, name: schema.indices.name }).from(schema.indices);

  let qeriIndexId: string | null = null;
  let dsmIndexId: string | null = null;
  for (const idx of indices) {
    const flag = flagForIndexName(idx.name);
    if (flag === "isQeriMember" && !qeriIndexId) qeriIndexId = idx.id;
    if (flag === "isDsmMember" && !dsmIndexId) dsmIndexId = idx.id;
  }

  const qeriMembers = qeriIndexId ? await memberStockIdsForIndex(qeriIndexId) : new Set<string>();
  const dsmMembers = dsmIndexId ? await memberStockIdsForIndex(dsmIndexId) : new Set<string>();

  const stockCount = await db.select({ id: schema.stocks.id }).from(schema.stocks).limit(1);
  if (stockCount.length === 0) return { qeriMembers: 0, dsmMembers: 0 };

  await db.update(schema.stocks).set({
    isQeriMember: false,
    isDsmMember: false,
    updatedAt: new Date(),
  });

  const qeriIds = [...qeriMembers];
  const dsmIds = [...dsmMembers];

  if (qeriIds.length) {
    await db.update(schema.stocks).set({
      isQeriMember: true,
      updatedAt: new Date(),
    }).where(inArray(schema.stocks.id, qeriIds));
  }

  if (dsmIds.length) {
    await db.update(schema.stocks).set({
      isDsmMember: true,
      updatedAt: new Date(),
    }).where(inArray(schema.stocks.id, dsmIds));
  }

  return { qeriMembers: qeriIds.length, dsmMembers: dsmIds.length };
}
