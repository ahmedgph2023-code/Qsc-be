/**
 * Load official closes from KB/Market-Data/Company-Closing-Prices-By-Ticker.md into stock_prices.
 * Usage: npx tsx scripts/import-kb-closes.ts
 */
import "dotenv/config";
import { importKbOfficialCloses } from "../src/services/official-closes.js";

async function main() {
  const result = await importKbOfficialCloses({});
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
