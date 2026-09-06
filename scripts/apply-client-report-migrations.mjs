import "dotenv/config";
import fs from "fs";
import pg from "pg";

function postgresPoolConfig(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  const hostname = url.hostname;
  const isLocal =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return {
    connectionString: url.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: false },
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("no DATABASE_URL");
  process.exit(1);
}

const pool = new pg.Pool(postgresPoolConfig(url));

async function run(file) {
  const sql = fs.readFileSync(file, "utf8");
  console.log("applying", file);
  await pool.query(sql);
  console.log("ok", file);
}

try {
  await run("drizzle/0019_client_report_configs.sql");
  await run("drizzle/0020_client_report_global_settings.sql");
  await run("drizzle/0022_client_report_delivery.sql");
  const t = await pool.query(
    "select to_regclass('public.client_report_global_settings') as g, to_regclass('public.client_report_configs') as c",
  );
  console.log("tables", t.rows[0]);
  const cols = await pool.query(
    "select column_name from information_schema.columns where table_name='client_report_global_settings' order by ordinal_position",
  );
  console.log(
    "cols",
    cols.rows.map((r) => r.column_name).join(","),
  );
} catch (e) {
  console.error("FAIL", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
