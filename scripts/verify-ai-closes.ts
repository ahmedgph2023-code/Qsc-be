import "dotenv/config";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../src/db/connection.js";

async function main() {
  const [tot] = await db
    .select({
      maxDate: sql`max(${schema.stockPrices.date})`.mapWith(String),
      rows: sql`count(*)::int`,
    })
    .from(schema.stockPrices);
  const mhar = await db
    .select({
      date: schema.stockPrices.date,
      price: schema.stockPrices.closePrice,
    })
    .from(schema.stockPrices)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockPrices.stockId))
    .where(and(sql`upper(${schema.stocks.ticker}) = 'MHAR'`, gte(schema.stockPrices.date, "2026-08-19")))
    .orderBy(desc(schema.stockPrices.date))
    .limit(8);
  console.log(JSON.stringify({ tot, mhar }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
