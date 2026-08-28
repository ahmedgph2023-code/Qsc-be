/**
 * Read-only probe of the external SQL Server. Prints aggregates only (no PII).
 * Env: MSSQL_HOST, MSSQL_PORT, MSSQL_USER, MSSQL_PASSWORD, optional MSSQL_DATABASE
 */
import "dotenv/config";
import sql from "mssql";

const config = {
  server: process.env.MSSQL_HOST || "127.0.0.1",
  port: Number(process.env.MSSQL_PORT || 11433),
  user: process.env.MSSQL_USER || "sa",
  password: process.env.MSSQL_PASSWORD || "",
  database: process.env.MSSQL_DATABASE || undefined,
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000,
  requestTimeout: 60000,
};

if (!config.password) {
  console.error("MSSQL_PASSWORD missing");
  process.exit(1);
}

const pool = await sql.connect(config);

const dbs = await pool.request().query(`
  SELECT name FROM sys.databases
  WHERE name NOT IN ('master','tempdb','model','msdb')
  ORDER BY name
`);
console.log("user_dbs", dbs.recordset.map((r) => r.name));

async function tableCount(dbName, table) {
  const r = await pool.request().query(`
    SELECT COUNT(*) AS c
    FROM [${dbName}].INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = '${table}'
  `);
  return Number(r.recordset[0].c);
}

const hits = [];
for (const { name } of dbs.recordset) {
  const share = await tableCount(name, "ShareTransactions");
  const cash = await tableCount(name, "CashTransactions");
  if (share || cash) hits.push({ name, share, cash });
}
console.log("dbs_with_tx_tables", hits);

const dbName = process.env.MSSQL_DATABASE || hits[0]?.name;
if (!dbName) {
  console.log("no_tx_tables");
  await pool.close();
  process.exit(0);
}
console.log("using_db", dbName);

const q = async (text) => {
  const r = await new sql.Request(pool).query(`USE [${dbName}]; ${text}`);
  return r.recordset;
};

const tables = await q(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE = 'BASE TABLE'
  ORDER BY TABLE_NAME
`);
console.log("all_tables", tables.map((r) => r.TABLE_NAME));

const counts = await q(`
  SELECT
    (SELECT COUNT(*) FROM ShareTransactions) AS share_n,
    (SELECT COUNT(*) FROM CashTransactions) AS cash_n,
    (SELECT COUNT(*) FROM ShareTransactions_Staging) AS share_stg_n,
    (SELECT COUNT(*) FROM CashTransactions_Staging) AS cash_stg_n,
    (SELECT COUNT(*) FROM SyncWatermark) AS wm_n
`);
console.log("row_counts", counts[0]);

const flags = await q(`
  SELECT BuySellFlag, COUNT(*) AS n
  FROM ShareTransactions
  GROUP BY BuySellFlag
  ORDER BY n DESC
`);
console.log("BuySellFlag", flags);

const inv = await q(`
  SELECT InvType, COUNT(*) AS n
  FROM ShareTransactions
  GROUP BY InvType
  ORDER BY n DESC
`);
console.log("InvType", inv);

const cashStatus = await q(`
  SELECT Status, COUNT(*) AS n
  FROM CashTransactions
  GROUP BY Status
  ORDER BY n DESC
`);
console.log("Cash.Status", cashStatus);

const cashDoc = await q(`
  SELECT TOP 20 DocCode, COUNT(*) AS n
  FROM CashTransactions
  GROUP BY DocCode
  ORDER BY n DESC
`);
console.log("Cash.DocCode_top", cashDoc);

const keys = await q(`
  SELECT
    COUNT(*) AS share_rows,
    COUNT(DISTINCT Nin) AS distinct_nin,
    COUNT(DISTINCT ClientId) AS distinct_client_id,
    COUNT(DISTINCT CONCAT(ISNULL(Nin,''), ':', CAST(ClientId AS varchar(20)))) AS distinct_nin_client
  FROM ShareTransactions
`);
console.log("share_keys", keys[0]);

const cashKeys = await q(`
  SELECT COUNT(*) AS cash_rows, COUNT(DISTINCT Nin) AS distinct_nin
  FROM CashTransactions
`);
console.log("cash_keys", cashKeys[0]);

const overlap = await q(`
  SELECT
    (SELECT COUNT(DISTINCT Nin) FROM ShareTransactions) AS share_nin,
    (SELECT COUNT(DISTINCT Nin) FROM CashTransactions) AS cash_nin,
    (
      SELECT COUNT(*) FROM (
        SELECT Nin FROM ShareTransactions WHERE Nin IS NOT NULL
        INTERSECT
        SELECT Nin FROM CashTransactions WHERE Nin IS NOT NULL
      ) x
    ) AS nin_in_both
`);
console.log("nin_overlap", overlap[0]);

const perClient = await q(`
  SELECT TOP 5
    COUNT(*) AS share_n,
    COUNT(DISTINCT TickerId) AS tickers
  FROM ShareTransactions
  GROUP BY Nin, ClientId
  ORDER BY COUNT(*) DESC
`);
console.log("top_accounts_share_counts", perClient);

const ninMulti = await q(`
  SELECT COUNT(*) AS nin_with_multiple_client_ids FROM (
    SELECT Nin
    FROM ShareTransactions
    WHERE Nin IS NOT NULL
    GROUP BY Nin
    HAVING COUNT(DISTINCT ClientId) > 1
  ) x
`);
console.log("nin_with_multiple_client_ids", ninMulti[0]);

const qtyNull = await q(`
  SELECT
    SUM(CASE WHEN Qty IS NULL THEN 1 ELSE 0 END) AS qty_null,
    SUM(CASE WHEN AvgPrice IS NULL THEN 1 ELSE 0 END) AS avg_null,
    SUM(CASE WHEN Total IS NULL THEN 1 ELSE 0 END) AS total_null,
    SUM(CASE WHEN Net IS NULL THEN 1 ELSE 0 END) AS net_null
  FROM ShareTransactions
`);
console.log("share_nulls", qtyNull[0]);

const cashNull = await q(`
  SELECT
    SUM(CASE WHEN DbAmt IS NULL THEN 1 ELSE 0 END) AS db_null,
    SUM(CASE WHEN CrAmt IS NULL THEN 1 ELSE 0 END) AS cr_null,
    SUM(CASE WHEN PostDate IS NULL THEN 1 ELSE 0 END) AS post_null,
    SUM(CASE WHEN DocDate IS NULL THEN 1 ELSE 0 END) AS doc_null
  FROM CashTransactions
`);
console.log("cash_nulls", cashNull[0]);

const dateRange = await q(`
  SELECT
    MIN(InvDate) AS share_min,
    MAX(InvDate) AS share_max,
    MIN(PostDate) AS cash_min,
    MAX(PostDate) AS cash_max
  FROM ShareTransactions
  CROSS JOIN (SELECT MIN(PostDate) AS PostDate FROM CashTransactions) c
`);
console.log("date_range", dateRange[0]);

const sampleShare = await q(`
  SELECT TOP 3
    TickerId, InvType, BuySellFlag, Qty, AvgPrice, Total, Net, TotalComm, OfficeComm, MarketComm
  FROM ShareTransactions
  ORDER BY InvDate
`);
console.log("sample_share_numeric", sampleShare);

const sampleCash = await q(`
  SELECT TOP 3 DocCode, ObjCode, DbAmt, CrAmt, DocAmt, Status
  FROM CashTransactions
  ORDER BY PostDate
`);
console.log("sample_cash_numeric", sampleCash);

const wm = await q(`SELECT EntityName, LastRunStatus, LastSyncedTime, LastRunAt FROM SyncWatermark`);
console.log("watermark", wm);

const clientMaster = await q(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE = 'BASE TABLE'
    AND (
      TABLE_NAME LIKE '%Client%'
      OR TABLE_NAME LIKE '%Customer%'
      OR TABLE_NAME LIKE '%Nin%'
      OR TABLE_NAME LIKE '%Account%'
    )
`);
console.log("possible_master_tables", clientMaster.map((r) => r.TABLE_NAME));

await pool.close();
