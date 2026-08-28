import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "./connection.js";
import { seed } from "./seed.js";
import { applyEndingCash, importHistoricalPackage } from "../services/historical-import.js";
import { firstSheetMatrix, readWorkbook, sheetObjectRows } from "../services/historical-sheet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const HIST = path.join(ROOT, "historical-data");

function findFile(root: string, fileName: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name.toLowerCase() === fileName.toLowerCase()) return full;
    }
  }
  return null;
}

function loadSectorMap(sectorsPath: string | null): Map<string, string> {
  const sectorMap = new Map<string, string>();
  if (!sectorsPath) return sectorMap;
  for (const row of sheetObjectRows(readWorkbook(sectorsPath))) {
    const code = String(row.S_CODE ?? "").trim();
    const name = String(row.E_S_DESC || row.S_DESC || "").replace(/^\d+-?\s*/, "").trim();
    if (code && name) sectorMap.set(code, name);
  }
  console.log(`[historical] Sector dictionary: ${sectorMap.size}`);
  return sectorMap;
}

async function applySnapshotCash(portfolioPath: string | null, cashPath: string | null, portfolioId: string | null) {
  if (!portfolioId) return;
  let endingCash: number | null = null;
  if (portfolioPath) {
    const matrix = firstSheetMatrix(readWorkbook(portfolioPath));
    for (const row of matrix) {
      if (String(row[0]).toUpperCase() === "CASH") {
        const n = Number(String(row[1]).replace(/,/g, ""));
        if (Number.isFinite(n)) endingCash = n;
      }
    }
  }
  if (endingCash != null) {
    await applyEndingCash(portfolioId, endingCash);
    console.log(`[historical] Portfolio cash set to ${endingCash} (from year-end snapshot)`);
    return;
  }
  if (!cashPath) return;
  const matrix = firstSheetMatrix(readWorkbook(cashPath));
  for (const row of matrix) {
    if (String(row[4]).includes("INV PORT") && Number(row[5])) {
      await applyEndingCash(portfolioId, Number(row[5]));
      console.log(`[historical] Portfolio cash set to ${row[5]} (from account summary)`);
      break;
    }
  }
}

async function seedHistorical() {
  console.log("[historical] Starting historical data seed…");
  await seed();

  const pricesPath = findFile(HIST, "CB_PRICES.xls");
  const sectorsPath = findFile(HIST, "SECTORS.xls");
  const securitiesPath = findFile(HIST, "CB_SEC_COMP.xls");
  const indexPath = findFile(HIST, "CH_CURRENT_INDEX.xls");
  const clientPath = findFile(HIST, "CMClientDetails.xls");
  const tradesPath = findFile(HIST, "PMProfitLossTransaction.xls");
  const cashPath = findFile(HIST, "FMClientAccountSummary.xls");
  const portfolioPath = findFile(HIST, "Portfolio31122025.xls") || findFile(HIST, "Portfolio31122024.xls");

  if (!pricesPath || !indexPath) {
    throw new Error(`Missing core historical files under ${HIST}`);
  }

  const result = await importHistoricalPackage({
    securitiesPath,
    pricesPath,
    indexPath,
    clientPath,
    tradesPath,
    cashPath,
    skipIfPopulated: true,
    sectorMap: loadSectorMap(sectorsPath),
  });

  await applySnapshotCash(portfolioPath, cashPath, result.portfolioId);

  const customer = result.customerId
    ? (await db.select().from(schema.customers).where(eq(schema.customers.id, result.customerId)).limit(1))[0]
    : null;
  const qeri = (await db.select().from(schema.indices).where(eq(schema.indices.name, "QERI")).limit(1))[0];
  const dsm = (await db.select().from(schema.indices).where(eq(schema.indices.name, "DSM")).limit(1))[0];
  const stockCount = (await db.select({ c: sql<number>`count(*)::int` }).from(schema.stocks))[0]?.c;
  console.log("[historical] Done.");
  console.log(`[historical] stocks=${stockCount} QERI=${qeri?.id} DSM=${dsm?.id} customer=${customer?.id} portfolio=${result.portfolioId}`);
}

seedHistorical()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[historical] FAILED", err);
    process.exit(1);
  });
