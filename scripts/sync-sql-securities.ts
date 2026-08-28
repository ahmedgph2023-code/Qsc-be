/**
 * Copy ticker + name + sector from SQL CB_SEC_COMP into Postgres stocks.
 * Does not invent prices or Shariah flags.
 *
 * Usage:
 *   npx tsx scripts/sync-sql-securities.ts          # dry-run
 *   npx tsx scripts/sync-sql-securities.ts --commit
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/connection.js";
import { fiKindFromTicker } from "../src/db/debt-tickers.js";
import { getMssqlPool, isExtSqlConfigured } from "../src/db/mssql.js";

function text(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

async function main() {
  const commit = process.argv.includes("--commit");
  if (!isExtSqlConfigured()) {
    console.log("EXT_SQL_UNCONFIGURED");
    process.exit(2);
  }

  const pool = await getMssqlPool();
  const companies = await pool.request().query(`
    SELECT TICKER_ID, SCE_LONG_NAME, SCA_LONG_NAME, SCE_SHORT_NAME, SCA_SHORT_NAME, SC_SEC_CODE
    FROM CB_SEC_COMP
  `);
  const sectors = await pool.request().query(`
    SELECT S_CODE, E_S_DESC, S_DESC FROM SECTORS
  `);
  const sectorByCode = new Map<string, string>();
  for (const row of sectors.recordset) {
    const rec = row as Record<string, unknown>;
    const code = text(rec, "S_CODE", "s_code", "sCode");
    const name = text(rec, "E_S_DESC", "e_s_desc", "eSDesc") || text(rec, "S_DESC", "s_desc", "sDesc");
    if (code && name) {
      sectorByCode.set(code, name);
      sectorByCode.set(String(Number(code)), name);
    }
  }

  const existing = await db.select({ id: schema.stocks.id, ticker: schema.stocks.ticker }).from(schema.stocks);
  const have = new Set(existing.map((s) => s.ticker.toUpperCase()));
  const toInsert: {
    ticker: string;
    companyName: string;
    sector: string;
    instrumentType: "equity" | "gov_bond" | "t_bill" | "sukuk" | "other_debt";
  }[] = [];
  const seen = new Set<string>();

  for (const raw of companies.recordset) {
    const row = raw as Record<string, unknown>;
    const ticker = text(row, "TICKER_ID", "ticker_id", "tickerId");
    if (!ticker) continue;
    const key = ticker.toUpperCase();
    if (seen.has(key) || have.has(key)) continue;
    seen.add(key);
    const kind = fiKindFromTicker(ticker);
    const secCode = text(row, "SC_SEC_CODE", "sc_sec_code", "scSecCode");
    const sectorName = sectorByCode.get(secCode) || sectorByCode.get(String(Number(secCode))) || "Unclassified";
    const companyName =
      text(row, "SCE_LONG_NAME", "sce_long_name", "sceLongName")
      || text(row, "SCA_LONG_NAME", "sca_long_name", "scaLongName")
      || text(row, "SCE_SHORT_NAME", "sce_short_name", "sceShortName")
      || text(row, "SCA_SHORT_NAME", "sca_short_name", "scaShortName")
      || ticker;
    toInsert.push({
      ticker,
      companyName: companyName.slice(0, 300),
      sector: (kind ? "Fixed Income" : sectorName).slice(0, 100),
      instrumentType: kind || "equity",
    });
  }

  console.log(`sql_companies=${companies.recordset.length}`);
  console.log(`postgres_stocks=${existing.length}`);
  console.log(`would_insert=${toInsert.length}`);
  for (const s of toInsert.slice(0, 20)) {
    console.log(`  ${s.ticker}\t${s.instrumentType}\t${s.companyName}`);
  }
  if (toInsert.length > 20) console.log(`  … ${toInsert.length - 20} more`);

  if (!commit) {
    console.log("dry-run (pass --commit to write). shariah_group left null. no prices written.");
    await pool.close();
    process.exit(0);
  }

  const BATCH = 200;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    await db.insert(schema.stocks).values(toInsert.slice(i, i + BATCH)).onConflictDoNothing();
  }

  let fiAdded = 0;
  for (const s of toInsert) {
    const kind = fiKindFromTicker(s.ticker);
    if (!kind) continue;
    const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.ticker, s.ticker)).limit(1);
    if (!stock) continue;
    const [existingFi] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, stock.id)).limit(1);
    if (existingFi) continue;
    await db.insert(schema.fiInstruments).values({
      stockId: stock.id,
      facePar: "100",
      couponRate: "0",
      couponFrequency: kind === "t_bill" ? "zero" : "semi_annual",
      dayCount: "ACT_PERIOD",
      termsComplete: false,
    });
    fiAdded += 1;
  }

  const after = await db.select({ ticker: schema.stocks.ticker }).from(schema.stocks);
  console.log(`postgres_stocks_after=${after.length} fi_stub_rows=${fiAdded}`);
  await pool.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
