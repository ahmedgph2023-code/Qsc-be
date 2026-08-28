/**
 * One-off fix: ERES had leftover test corporate actions (a DIVIDEND and a
 * BONUS) that weren't from the real AGM/EGM source documents. This deletes
 * them the same way the DELETE /stocks/:id/corporate-actions/:caid route
 * does (reverse portfolio effects, delete the row, rebuild adjusted prices).
 *
 * Per the AGM/EGM 2023/2024/2025 documents, ERES proposed NO cash dividend
 * and NO bonus/split in any of those 3 fiscal years — so nothing is
 * re-added for it here. If real ERES corporate actions turn up later, add
 * them the same way as scripts/seed-corporate-actions-2023-2025.ts does.
 *
 * Usage: npx tsx scripts/reset-eres-corporate-actions.ts
 */
import "dotenv/config";
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://qse:qse_password@localhost:5433/qse";
}

const { db, schema } = await import("../src/db/connection.js");
const { eq } = await import("drizzle-orm");
const { rebuildAdjustedPrices } = await import("../src/services/adjusted-prices.js");
const { reverseCorporateActionApplications } = await import("../src/services/corporate-action-portfolio.js");

async function main() {
  const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.ticker, "ERES")).limit(1);
  if (!stock) throw new Error("ERES not found in stocks table");

  const actions = await db
    .select()
    .from(schema.corporateActions)
    .where(eq(schema.corporateActions.stockId, stock.id));

  console.log(`ERES: found ${actions.length} existing corporate action(s):`);
  for (const a of actions) {
    console.log(`  - ${a.actionType} on ${a.actionDate} (ratio ${a.ratio ?? "-"}, cash ${a.cashAmount ?? "-"}) [${a.id}]`);
  }

  for (const a of actions) {
    const reversed = await reverseCorporateActionApplications(a.id);
    await db.delete(schema.corporateActions).where(eq(schema.corporateActions.id, a.id));
    console.log(`  [deleted] ${a.actionType} ${a.actionDate} — reversed ${reversed.reversed} portfolio application(s), cash reversed ${reversed.cashReversed}`);
  }

  await rebuildAdjustedPrices(stock.id);

  console.log(
    "\nERES now has 0 corporate actions, matching the AGM/EGM 2023-2025 source documents (no dividend/bonus/split proposed in any of those fiscal years).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
