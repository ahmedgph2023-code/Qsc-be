/**
 * Read-only: SQL ClientPortfolioSnapshot vs IPMS reconstruction.
 * Does not write SQL. Does not persist Postgres unless --commit.
 * Usage: npx tsx scripts/characterize-sql-snapshot.ts
 *         npx tsx scripts/characterize-sql-snapshot.ts --commit
 *         npx tsx scripts/characterize-sql-snapshot.ts --asOf=2026-08-27 --commit
 *         npx tsx scripts/characterize-sql-snapshot.ts --dates-only
 */
import "dotenv/config";
import { eq, max } from "drizzle-orm";
import { db, schema } from "../src/db/connection.js";
import { isExtSqlConfigured } from "../src/db/mssql.js";
import {
  loadCash,
  loadClientPortfolioSnapshots,
  loadOfficialCloses,
  loadShares,
  latestQscSnapshotDate,
  listQscSnapshotDates,
} from "../src/services/ext-sql-clients.js";
import { cashBalance, toYmd } from "../src/services/ext-sql-portfolio.js";
import { compareSnapshot, ipmsMarketValue, runDailySnapshot } from "../src/services/snapshot-recon.js";
import { lotsFromShares } from "../src/services/statement-portfolio.js";
import { UAT_SAAD } from "../src/services/statement-uat.js";
import { getMssqlPool } from "../src/db/mssql.js";
import { roundMoney } from "../src/lib/money.js";

async function main() {
  if (!isExtSqlConfigured()) {
    console.log(JSON.stringify({ error: "EXT_SQL_UNCONFIGURED" }));
    process.exit(2);
  }
  const commit = process.argv.includes("--commit");
  const datesOnly = process.argv.includes("--dates-only");
  const asOfArg = process.argv.find((a) => a.startsWith("--asOf="))?.slice("--asOf=".length);
  if (datesOnly) {
    const sqlDates = await listQscSnapshotDates();
    const latestQscDate = sqlDates[0]?.date ?? null;
    const sampleSql = latestQscDate
      ? (await loadClientPortfolioSnapshots(latestQscDate)).find((r) => r.clientId === UAT_SAAD.accountId) ?? null
      : null;
    const stored = await db.select({
      d: schema.ipmsClientSnapshots.snapshotDate,
    }).from(schema.ipmsClientSnapshots)
      .groupBy(schema.ipmsClientSnapshots.snapshotDate);
    const [priceAgg] = await db.select({ maxDate: max(schema.stockPrices.date) }).from(schema.stockPrices);
    console.log(JSON.stringify({
      sqlDates,
      storedDates: stored.map((r) => String(r.d).slice(0, 10)).sort().reverse(),
      latestQscDate,
      maxOfficialCloseDate: priceAgg?.maxDate ?? null,
      sample: sampleSql ? {
        clientId: sampleSql.clientId,
        snapshotDate: sampleSql.snapshotDate,
        portfolioValue: sampleSql.portfolioValue,
        systemCash: sampleSql.systemCash,
        bankBalance: sampleSql.bankBalance,
        updatedAt: sampleSql.updatedAt ? sampleSql.updatedAt.toISOString() : null,
      } : null,
    }, null, 2));
    process.exit(0);
  }
  const pool = await getMssqlPool();
  const dates = await pool.request().query(`
    SELECT CAST(SnapshotDate AS date) AS d, COUNT(*) AS n
    FROM ClientPortfolioSnapshot
    GROUP BY CAST(SnapshotDate AS date)
    ORDER BY d DESC
  `);
  const latestQscDate = await latestQscSnapshotDate();
  const [priceAgg] = await db.select({ maxDate: max(schema.stockPrices.date) }).from(schema.stockPrices);
  const asOf = asOfArg || latestQscDate;
  const sqlRows = asOf ? await loadClientPortfolioSnapshots(asOf) : [];
  const sampleSql = sqlRows.find((r) => r.clientId === UAT_SAAD.accountId) ?? null;

  let sampleIpms: Record<string, unknown> | null = null;
  if (asOf && sampleSql) {
    const [shares, cash] = await Promise.all([
      loadShares(UAT_SAAD.accountId, asOf),
      loadCash(UAT_SAAD.accountId, asOf),
    ]);
    const lots = lotsFromShares(shares, asOf, new Map(), new Map());
    const tickers = [...new Set(lots.map((l) => l.ticker.trim()).filter(Boolean))];
    const closes = await loadOfficialCloses(tickers, asOf);
    const valued = ipmsMarketValue(lots, closes);
    const ipmsCash = roundMoney(cashBalance(cash, asOf), 4);
    const ipmsNav = valued.marketValue == null ? null : roundMoney(valued.marketValue + ipmsCash, 4);
    const compared = compareSnapshot({
      hasQsc: true,
      qscPortfolioValue: sampleSql.portfolioValue,
      qscSystemCash: sampleSql.systemCash,
      ipmsMarketValue: valued.marketValue,
      ipmsCash,
      ipmsNavMvPlusCash: ipmsNav,
      missingCloses: valued.missingCloses,
    });
    sampleIpms = {
      lots: lots.length,
      tickersPriced: closes.size,
      ipmsCash,
      ipmsMarketValue: valued.marketValue,
      ipmsNavMvPlusCash: ipmsNav,
      missingCloses: valued.missingCloses,
      compared,
    };
  }

  let commitResult: unknown = null;
  if (commit && asOf) {
    commitResult = await runDailySnapshot(asOf, null);
  }

  const stored = asOf
    ? await db.select({
      clientId: schema.ipmsClientSnapshots.clientId,
      status: schema.ipmsClientSnapshots.status,
    }).from(schema.ipmsClientSnapshots).where(eq(schema.ipmsClientSnapshots.snapshotDate, asOf))
    : [];

  console.log(JSON.stringify({
    asOf,
    latestQscDate,
    sqlDates: dates.recordset.map((r: Record<string, unknown>) => ({
      date: toYmd(r.d ?? r.D) || String(r.d ?? r.D ?? "").slice(0, 10),
      rows: Number(r.n ?? r.N ?? 0),
    })),
    sqlRowCount: sqlRows.length,
    maxOfficialCloseDate: priceAgg?.maxDate ?? null,
    sample: {
      clientId: UAT_SAAD.accountId,
      qsc: sampleSql,
      ipms: sampleIpms,
    },
    commit,
    commitResult,
    storedCount: stored.length,
    storedByStatus: stored.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
