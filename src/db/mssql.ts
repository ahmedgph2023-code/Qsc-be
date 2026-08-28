import sql from "mssql";

export type MssqlEnvConfig = {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
  options: { encrypt: boolean; trustServerCertificate: boolean };
};

export function mssqlEnvConfig(): MssqlEnvConfig | null {
  const password = process.env.MSSQL_PASSWORD;
  if (!password) return null;
  return {
    server: process.env.MSSQL_HOST || process.env.MSSQL_SERVER || "127.0.0.1",
    port: Number(process.env.MSSQL_PORT || 11433),
    user: process.env.MSSQL_USER || "sa",
    password,
    database: process.env.MSSQL_DATABASE || "OracleIntegration",
    options: {
      encrypt: process.env.MSSQL_ENCRYPT === "true",
      trustServerCertificate: process.env.MSSQL_TRUST_CERT !== "false",
    },
  };
}

export function isExtSqlConfigured(): boolean {
  return mssqlEnvConfig() != null;
}

let pool: sql.ConnectionPool | null = null;
let connecting: Promise<sql.ConnectionPool> | null = null;

export async function getMssqlPool(): Promise<sql.ConnectionPool> {
  const cfg = mssqlEnvConfig();
  if (!cfg) {
    const err = new Error("External SQL is not configured") as Error & { status: number; code: string };
    err.status = 503;
    err.code = "EXT_SQL_UNCONFIGURED";
    throw err;
  }
  if (pool?.connected) return pool;
  if (connecting) return connecting;

  connecting = (async () => {
    const next = new sql.ConnectionPool({
      server: cfg.server,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      options: cfg.options,
      connectionTimeout: 15_000,
      requestTimeout: 60_000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    });
    await next.connect();
    pool = next;
    return next;
  })();

  try {
    const connected = await connecting;
    connecting = null;
    return connected;
  } catch (err) {
    connecting = null;
    pool = null;
    throw err;
  }
}

export { sql };
