import "dotenv/config";
import sql from "mssql";

const pool = await sql.connect({
  server: process.env.MSSQL_HOST,
  port: Number(process.env.MSSQL_PORT),
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: "OracleIntegration",
  options: { encrypt: false, trustServerCertificate: true },
});

const q = (t) => pool.request().query(t).then((r) => r.recordset);

console.log("inv_x_flag", await q(`
  SELECT InvType, BuySellFlag, COUNT(*) n
  FROM ShareTransactions
  GROUP BY InvType, BuySellFlag
  ORDER BY InvType, BuySellFlag
`));

console.log("cash_dates", await q(`
  SELECT MIN(PostDate) post_min, MAX(PostDate) post_max,
         MIN(DocDate) doc_min, MAX(DocDate) doc_max
  FROM CashTransactions
`));

console.log("obj_vs_client", await q(`
  SELECT
    (SELECT COUNT(DISTINCT ClientId) FROM ShareTransactions) share_clients,
    (SELECT COUNT(DISTINCT ObjCode) FROM CashTransactions) cash_obj,
    (
      SELECT COUNT(*) FROM (
        SELECT DISTINCT ClientId FROM ShareTransactions
        INTERSECT
        SELECT DISTINCT ObjCode FROM CashTransactions
      ) x
    ) overlap
`));

console.log("status_a_n_amt", await q(`
  SELECT COUNT(*) n,
         SUM(ISNULL(DbAmt,0)) db,
         SUM(ISNULL(CrAmt,0)) cr
  FROM CashTransactions WHERE Status = 'A'
`));

console.log("sp_rows", await q(`
  SELECT TickerId, BuySellFlag, Qty, AvgPrice, Total, Net, TotalComm
  FROM ShareTransactions WHERE InvType = 'SP'
`));

console.log("nin_eq_client", await q(`
  SELECT COUNT(*) n FROM (
    SELECT DISTINCT Nin, ClientId FROM ShareTransactions
  ) x WHERE TRY_CONVERT(int, Nin) = ClientId
`));

console.log("ids", await q(`
  SELECT MIN(ClientId) min_id, MAX(ClientId) max_id,
         MIN(LEN(Nin)) nin_min, MAX(LEN(Nin)) nin_max
  FROM ShareTransactions
`));

console.log("cash_obj", await q(`
  SELECT MIN(ObjCode) min_obj, MAX(ObjCode) max_obj,
         MIN(MainObjCode) min_main, MAX(MainObjCode) max_main
  FROM CashTransactions
`));

console.log("one_client_cash_vs_share", await q(`
  SELECT TOP 1 s.ClientId, s.Nin,
    (SELECT COUNT(*) FROM CashTransactions c WHERE c.Nin = s.Nin) cash_by_nin,
    (SELECT COUNT(*) FROM CashTransactions c WHERE c.ObjCode = s.ClientId) cash_by_obj
  FROM (SELECT DISTINCT ClientId, Nin FROM ShareTransactions) s
`));

await pool.close();
