/**
 * Discover Investor Details table/columns in QSC SQL (client promised Aug 2026).
 * Usage: SSH tunnel first, then: npx tsx scripts/discover-investor-details.ts
 */
import "dotenv/config";
import { getMssqlPool, isExtSqlConfigured, sql } from "../src/db/mssql.js";

async function main() {
  if (!isExtSqlConfigured()) {
    console.log("EXT_SQL_UNCONFIGURED");
    process.exit(2);
  }
  const pool = await getMssqlPool();

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
      AND (
        TABLE_NAME LIKE '%Investor%'
        OR TABLE_NAME LIKE '%INVESTOR%'
        OR TABLE_NAME LIKE '%Client%Detail%'
      )
    ORDER BY TABLE_NAME
  `);

  console.log("MATCHING_TABLES");
  for (const row of tables.recordset) {
    console.log(`  ${String(row.TABLE_NAME)}`);
  }

  for (const row of tables.recordset) {
    const tableName = String(row.TABLE_NAME);
    const cols = await pool.request()
      .input("t", sql.NVarChar(128), tableName)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION
      `);
    console.log(`\nTABLE ${tableName}`);
    for (const c of cols.recordset) {
      const len = c.CHARACTER_MAXIMUM_LENGTH != null ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : "";
      console.log(`  ${String(c.COLUMN_NAME)} ${String(c.DATA_TYPE)}${len}`);
    }

    try {
      const sample = await pool.request().query(`SELECT TOP 3 * FROM [${tableName.replace(/]/g, "]]")}]`);
      console.log(`SAMPLE_ROWS ${tableName}: ${sample.recordset.length}`);
      if (sample.recordset[0]) {
        console.log(JSON.stringify(sample.recordset[0], null, 2));
      }
    } catch (e) {
      console.log(`SAMPLE_SKIP ${tableName}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await pool.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
