import "dotenv/config";
import { getMssqlPool, isExtSqlConfigured } from "../src/db/mssql.js";

async function main() {
  console.log("configured", isExtSqlConfigured());
  const pool = await getMssqlPool();
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'ClientCurrentOrders'
    ORDER BY ORDINAL_POSITION
  `);
  console.log("COLS", JSON.stringify(cols.recordset, null, 2));
  try {
    const sample = await pool.request().query("SELECT TOP 2 * FROM ClientCurrentOrders");
    console.log("SAMPLE_KEYS", sample.recordset[0] ? Object.keys(sample.recordset[0]) : []);
    console.log("SAMPLE", JSON.stringify(sample.recordset, null, 2).slice(0, 4000));
  } catch (e: any) {
    console.log("SAMPLE_ERR", e?.message || e);
  }
  const types = await pool.request().query(`
    SELECT TOP 20 CL_CLIENT_TYPE, COUNT(*) n
    FROM Investors
    GROUP BY CL_CLIENT_TYPE
    ORDER BY n DESC
  `);
  console.log("CLIENT_TYPES", JSON.stringify(types.recordset, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
