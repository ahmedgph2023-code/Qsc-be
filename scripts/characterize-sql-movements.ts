/**
 * Read-only observation of SQL movement codes for sample account 2041929.
 * Does not change engines. Output is evidence for questions 9–11 / 20 / Balances.
 * Usage: npx tsx scripts/characterize-sql-movements.ts
 */
import "dotenv/config";
import { getMssqlPool, isExtSqlConfigured, sql } from "../src/db/mssql.js";
import { UAT_SAAD } from "../src/services/statement-uat.js";

async function main() {
  if (!isExtSqlConfigured()) {
    console.log(JSON.stringify({ error: "EXT_SQL_UNCONFIGURED" }));
    process.exit(2);
  }
  const pool = await getMssqlPool();
  const accountId = UAT_SAAD.accountId;

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);

  const balanceLike = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
      AND (
        TABLE_NAME LIKE N'%Balance%'
        OR TABLE_NAME LIKE N'%BAL%'
        OR TABLE_NAME LIKE N'%Position%'
      )
    ORDER BY TABLE_NAME
  `);

  const invTypes = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT UPPER(LTRIM(RTRIM(ISNULL(InvType, N'')))) AS invType,
             UPPER(LTRIM(RTRIM(ISNULL(BuySellFlag, N'')))) AS buySellFlag,
             COUNT(*) AS n,
             SUM(CAST(Qty AS float)) AS qty,
             SUM(CAST(Net AS float)) AS net
      FROM ShareTransactions
      WHERE ClientId = @id
      GROUP BY UPPER(LTRIM(RTRIM(ISNULL(InvType, N'')))),
               UPPER(LTRIM(RTRIM(ISNULL(BuySellFlag, N''))))
      ORDER BY n DESC
    `);

  const invoices = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT InvNo, InvType, BuySellFlag, TickerId, CAST(InvDate AS date) AS invDate,
             Qty, Net, Total, TotalComm
      FROM ShareTransactions
      WHERE ClientId = @id AND InvNo IN (37012, 37013)
      ORDER BY InvNo, Id
    `);

  const sharesBefore = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT COUNT(*) AS n, SUM(CAST(Qty AS float)) AS qty
      FROM ShareTransactions
      WHERE ClientId = @id AND CAST(InvDate AS date) < '2024-07-02'
    `);

  const cashBefore = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT COUNT(*) AS n,
             SUM(CAST(CrAmt AS float) - CAST(DbAmt AS float)) AS net
      FROM CashTransactions
      WHERE ObjCode = @id AND CAST(PostDate AS date) < '2024-07-01'
    `);

  const firstCash = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT TOP 5 CAST(PostDate AS date) AS postDate, DocCode, DocNo, DbAmt, CrAmt, Remarks, ERemarks
      FROM CashTransactions
      WHERE ObjCode = @id
      ORDER BY PostDate, Id
    `);

  const docCodes = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT UPPER(LTRIM(RTRIM(ISNULL(DocCode, N'')))) AS docCode,
             COUNT(*) AS n,
             SUM(CAST(DbAmt AS float)) AS debit,
             SUM(CAST(CrAmt AS float)) AS credit,
             MIN(Remarks) AS remarksAr,
             MIN(ERemarks) AS remarksEn
      FROM CashTransactions
      WHERE ObjCode = @id
      GROUP BY UPPER(LTRIM(RTRIM(ISNULL(DocCode, N''))))
      ORDER BY n DESC
    `);

  const samplesByDoc = [];
  for (const row of docCodes.recordset) {
    const sample = await pool.request()
      .input("id", sql.Int, accountId)
      .input("code", sql.NVarChar(16), String(row.docCode))
      .query(`
        SELECT TOP 1 CAST(PostDate AS date) AS postDate, DocNo, DbAmt, CrAmt, Remarks, ERemarks
        FROM CashTransactions
        WHERE ObjCode = @id AND UPPER(LTRIM(RTRIM(ISNULL(DocCode, N'')))) = @code
        ORDER BY PostDate, Id
      `);
    samplesByDoc.push({ docCode: row.docCode, sample: sample.recordset[0] ?? null });
  }

  const pv = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT CAST(PostDate AS date) AS postDate, DocCode, DocNo, DbAmt, CrAmt, Remarks, ERemarks
      FROM CashTransactions
      WHERE ObjCode = @id AND UPPER(LTRIM(RTRIM(ISNULL(DocCode, N'')))) = N'PV'
      ORDER BY PostDate, Id
    `);

  const snapshotCols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = N'ClientPortfolioSnapshot'
    ORDER BY ORDINAL_POSITION
  `);
  const snapshotCount = await pool.request().query(`SELECT COUNT(*) AS n FROM ClientPortfolioSnapshot`);
  const snapshotSample = await pool.request()
    .input("id", sql.Int, accountId)
    .query(`
      SELECT ClientId, SnapshotDate, PortfolioValue, SystemCash, BankBalance, UpdatedAt
      FROM ClientPortfolioSnapshot
      WHERE ClientId = @id
    `);

  const report = {
    accountId,
    nin: UAT_SAAD.nin,
    allTables: tables.recordset.map((r: { TABLE_NAME: string }) => r.TABLE_NAME),
    balanceLikeTables: balanceLike.recordset.map((r: { TABLE_NAME: string }) => r.TABLE_NAME),
    shareInvTypes: invTypes.recordset,
    invoices37012_37013: invoices.recordset,
    sharesBeforeFirstBuy: sharesBefore.recordset[0] ?? null,
    cashBeforeFirstFunding: cashBefore.recordset[0] ?? null,
    firstCashRows: firstCash.recordset,
    cashDocCodes: docCodes.recordset,
    cashDocSamples: samplesByDoc,
    pvRows: pv.recordset,
    snapshot: {
      columns: snapshotCols.recordset,
      rowCount: snapshotCount.recordset[0]?.n ?? 0,
      sample: snapshotSample.recordset,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  await pool.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
