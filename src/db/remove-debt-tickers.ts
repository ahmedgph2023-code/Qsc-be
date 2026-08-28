/**
 * QSE rights cleanup only — fixed income tickers are kept.
 * Legacy name retained for npm script compatibility.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./connection.js";
import { isQseRightsTicker } from "./debt-tickers.js";

async function removeRightsTickers() {
  const all = await db.select().from(schema.stocks);
  const rights = all.filter((s) => isQseRightsTicker(s.ticker));

  if (rights.length === 0) {
    console.log("[remove-debt] No rights (R0) tickers found — nothing to delete");
    return;
  }

  const ids = rights.map((s) => s.id);
  console.log(`[remove-debt] Removing ${rights.length} rights tickers: ${rights.map((r) => r.ticker).join(", ")}`);

  // Clear FI links if any
  await db.delete(schema.fiInstruments).where(inArray(schema.fiInstruments.stockId, ids));
  await db.delete(schema.stockPrices).where(inArray(schema.stockPrices.stockId, ids));
  await db.delete(schema.transactions).where(inArray(schema.transactions.stockId, ids));
  await db.delete(schema.stocks).where(inArray(schema.stocks.id, ids));
  console.log("[remove-debt] Done");
}

removeRightsTickers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[remove-debt] FAILED", err);
    process.exit(1);
  });
