/**
 * Import official closes from files/AI prices as of 30.08.2026.xlsx (Bloomberg Last price sheet).
 * Usage: npx tsx scripts/import-ai-bloomberg-closes.ts
 * Optional: --from=2026-08-19
 */
import "dotenv/config";
import { importAiBloombergOfficialCloses } from "../src/services/official-closes.js";

async function main() {
  const fromArg = process.argv.find((a) => a.startsWith("--from="));
  const fromDate = fromArg?.slice("--from=".length);
  const result = await importAiBloombergOfficialCloses({ fromDate });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
