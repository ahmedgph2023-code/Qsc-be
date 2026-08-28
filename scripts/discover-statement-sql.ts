import "dotenv/config";
import { getMssqlPool, isExtSqlConfigured, sql } from "../src/db/mssql.js";

const TABLES = ["Investors", "SECTORS", "CB_SEC_COMP", "ShareTransactions", "CashTransactions"];

async function main() {
  if (!isExtSqlConfigured()) {
    console.log("EXT_SQL_UNCONFIGURED");
    process.exit(2);
  }
  const pool = await getMssqlPool();
  const allTables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  console.log("ALL_TABLES");
  for (const row of allTables.recordset) {
    console.log(`  ${String(row.TABLE_NAME)}`);
  }
  for (const table of TABLES) {
    const result = await pool.request()
      .input("t", sql.NVarChar(128), table)
      .query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION
      `);
    console.log(`TABLE ${table}`);
    for (const row of result.recordset) {
      console.log(`  ${String(row.COLUMN_NAME)}`);
    }
  }
  await pool.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
