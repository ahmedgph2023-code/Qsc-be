/**
 * Report share-ledger dates that have no official close in Postgres stock_prices.
 * Does not interpolate. Writes files under meeting/ for QSC / Kajok.
 *
 * Usage: npx tsx scripts/price-gap-report.ts [asOf=YYYY-MM-DD]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, schema } from "../src/db/connection.js";
import { getMssqlPool, isExtSqlConfigured, sql } from "../src/db/mssql.js";
import { getPortfolioStatement } from "../src/services/ext-sql-clients.js";

const SAMPLE_ACCOUNT = 2041929;
const SAMPLE_NIN = "37808";
const CHECKPOINT = "2024-12-01";

function toYmd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function repoMeetingDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../meeting");
}

async function main() {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] || "")
    ? process.argv[2]
    : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Qatar" });

  if (!isExtSqlConfigured()) {
    console.log("EXT_SQL_UNCONFIGURED");
    process.exit(2);
  }

  const pool = await getMssqlPool();

  const priceTables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
      AND (
        TABLE_NAME LIKE '%PRICE%'
        OR TABLE_NAME LIKE '%CLOSE%'
        OR TABLE_NAME LIKE 'CB_%'
      )
    ORDER BY TABLE_NAME
  `);
  const sqlPriceLikeTables = priceTables.recordset.map((r) => String(r.TABLE_NAME));

  const shareDates = await pool.request().input("asOf", sql.Date, asOf).query(`
    SELECT DISTINCT LTRIM(RTRIM(TickerId)) AS ticker, CAST(InvDate AS date) AS invDate
    FROM ShareTransactions
    WHERE CAST(InvDate AS date) <= @asOf
      AND LTRIM(RTRIM(TickerId)) <> ''
    ORDER BY ticker, invDate
  `);

  const byTicker = new Map<string, string[]>();
  for (const row of shareDates.recordset) {
    const ticker = String(row.ticker || "").trim();
    const d = toYmd(row.invDate);
    if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const list = byTicker.get(ticker) || [];
    list.push(d);
    byTicker.set(ticker, list);
  }

  const companies = await pool.request().query(`
    SELECT LTRIM(RTRIM(TICKER_ID)) AS ticker,
           COALESCE(NULLIF(LTRIM(RTRIM(SCE_LONG_NAME)), ''), NULLIF(LTRIM(RTRIM(SCA_LONG_NAME)), ''), LTRIM(RTRIM(TICKER_ID))) AS name
    FROM CB_SEC_COMP
    WHERE LTRIM(RTRIM(TICKER_ID)) <> ''
  `);
  const companyName = new Map<string, string>();
  for (const row of companies.recordset) {
    const ticker = String(row.ticker || "").trim();
    if (ticker) companyName.set(ticker, String(row.name || ticker).trim());
  }

  const stocks = await db.select({ id: schema.stocks.id, ticker: schema.stocks.ticker }).from(schema.stocks);
  const tickerToId = new Map(stocks.map((s) => [s.ticker, s.id]));
  const prices = await db.select({
    stockId: schema.stockPrices.stockId,
    date: schema.stockPrices.date,
  }).from(schema.stockPrices);
  const datesByStockId = new Map<string, Set<string>>();
  for (const row of prices) {
    const set = datesByStockId.get(row.stockId) || new Set<string>();
    set.add(toYmd(row.date));
    datesByStockId.set(row.stockId, set);
  }

  const missing: Array<{ ticker: string; date: string; reason: string }> = [];
  const unknownTicker: string[] = [];

  for (const [ticker, dates] of [...byTicker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stockId = tickerToId.get(ticker);
    if (!stockId) {
      unknownTicker.push(ticker);
      continue;
    }
    const have = datesByStockId.get(stockId) || new Set<string>();
    for (const d of dates) {
      if (!have.has(d)) missing.push({ ticker, date: d, reason: "NO_CLOSE_ON_SHARE_DATE" });
    }
    if (asOf >= CHECKPOINT && !have.has(CHECKPOINT) && dates.some((d) => d <= CHECKPOINT)) {
      if (!missing.some((m) => m.ticker === ticker && m.date === CHECKPOINT)) {
        missing.push({ ticker, date: CHECKPOINT, reason: "NO_CLOSE_ON_PORTFOLIO_SAMPLE_ASOF" });
      }
    }
  }

  let sampleMissing: string[] = [];
  let sampleTickers: string[] = [];
  let samplePriced = 0;
  try {
    const stmt = await getPortfolioStatement(SAMPLE_ACCOUNT, asOf >= CHECKPOINT ? CHECKPOINT : asOf);
    if (stmt) {
      sampleTickers = stmt.sectors.flatMap((s) => s.lines.map((l) => l.ticker));
      sampleMissing = stmt.missingCloses;
      samplePriced = stmt.sectors.flatMap((s) => s.lines).filter((l) => l.priceSource === "official_close").length;
    }
  } catch (err) {
    console.error("[price-gap] sample statement failed", err instanceof Error ? err.message : err);
  }

  const outDir = repoMeetingDir();
  mkdirSync(outDir, { recursive: true });
  const stamp = asOf;
  const csvPath = path.join(outDir, `PRICE-GAP-${stamp}.csv`);
  const mdPath = path.join(outDir, `PRICE-GAP-${stamp}.md`);

  const csvLines = ["ticker,date,reason,company"];
  for (const row of missing) {
    csvLines.push([row.ticker, row.date, row.reason, JSON.stringify(companyName.get(row.ticker) || "")].join(","));
  }
  for (const t of unknownTicker) {
    csvLines.push([t, "", "UNKNOWN_IN_POSTGRES_STOCK_MASTER", JSON.stringify(companyName.get(t) || "")].join(","));
  }
  writeFileSync(csvPath, csvLines.join("\n"), "utf8");

  const md = [
    `# Price gap report — official closes`,
    ``,
    `Generated for Kajok / QSC. **Do not interpolate.** Official statement MV = shares × close **on that date** in IPMS Postgres \`stock_prices\`.`,
    ``,
    `| Field | Value |`,
    `| --- | --- |`,
    `| asOf (share-ledger cutoff) | ${asOf} |`,
    `| Sample investor | NIN ${SAMPLE_NIN} / account ${SAMPLE_ACCOUNT} |`,
    `| Sample statement date | ${asOf >= CHECKPOINT ? CHECKPOINT : asOf} |`,
    `| Tickers in SQL share blotter | ${byTicker.size} |`,
    `| Tickers in Postgres stock master | ${stocks.length} |`,
    `| Companies in SQL CB_SEC_COMP | ${companyName.size} |`,
    `| Missing closes (known tickers) | ${missing.length} |`,
    `| Unknown in Postgres master | ${unknownTicker.length} |`,
    `| Sample holdings priced | ${samplePriced} / ${sampleTickers.length} |`,
    `| Sample missing closes | ${sampleMissing.length ? sampleMissing.join(", ") : "(none or no lots)"} |`,
    `| SQL tables that look like prices | ${sqlPriceLikeTables.join(", ") || "(none)"} |`,
    ``,
    `## What QSC / Kajok should send`,
    ``,
    `1. Official daily close for every row in \`${path.basename(csvPath)}\` (ticker + date).`,
    `2. Security master matching \`CB_SEC_COMP\` for unknown tickers (names already listed from SQL).`,
    `3. Confirm: do **not** use last trade as statement close.`,
    ``,
    `IPMS will not invent prices. Screen last-trade fallback stays off the official statement.`,
    ``,
    `## Sample account holdings missing a close on ${asOf >= CHECKPOINT ? CHECKPOINT : asOf}`,
    ``,
    sampleMissing.length
      ? sampleMissing.map((t) => `- \`${t}\` ${companyName.get(t) || ""}`).join("\n")
      : "- (none, or statement returned no lots)",
    ``,
    `## Unknown tickers (in SQL trades, not in Postgres \`stocks\`)`,
    ``,
    unknownTicker.length
      ? unknownTicker.map((t) => `- \`${t}\` ${companyName.get(t) || ""}`).join("\n")
      : "- (none)",
    ``,
    `Full grid: \`${path.basename(csvPath)}\`.`,
    ``,
  ].join("\n");
  writeFileSync(mdPath, md, "utf8");

  console.log(`asOf=${asOf}`);
  console.log(`tickers_in_shares=${byTicker.size}`);
  console.log(`postgres_stocks=${stocks.length}`);
  console.log(`cb_sec_comp=${companyName.size}`);
  console.log(`unknown_in_stock_master=${unknownTicker.length}`);
  console.log(`missing_closes=${missing.length}`);
  console.log(`sample_account=${SAMPLE_ACCOUNT} priced=${samplePriced} missing=${sampleMissing.join("|") || "none"}`);
  console.log(`sql_price_like_tables=${sqlPriceLikeTables.join("|") || "none"}`);
  console.log(`wrote ${mdPath}`);
  console.log(`wrote ${csvPath}`);

  await pool.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
