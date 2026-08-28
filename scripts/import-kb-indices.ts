/**
 * Load QERI + DSM levels from KB/Market-Data/Index-Historical-Levels.md into index_data_points.
 * Usage: npx tsx scripts/import-kb-indices.ts
 */
import "dotenv/config";
import { importKbIndexLevels } from "../src/services/kb-indices.js";

async function main() {
  const result = await importKbIndexLevels({});
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
