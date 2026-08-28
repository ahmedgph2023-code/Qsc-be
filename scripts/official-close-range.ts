import "dotenv/config";
import { count, max } from "drizzle-orm";
import { db, schema } from "../src/db/connection.js";

const [row] = await db.select({
  maxDate: max(schema.stockPrices.date),
  n: count(),
}).from(schema.stockPrices);

console.log(JSON.stringify({
  maxOfficialCloseDate: row?.maxDate ?? null,
  stockPriceRows: Number(row?.n ?? 0),
}));
process.exit(0);
