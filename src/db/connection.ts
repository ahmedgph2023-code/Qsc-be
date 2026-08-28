import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * pg 8.16+ treats sslmode=require as verify-full. Supabase pooler (and some
 * local proxies) present a chain Node does not trust, which throws
 * SELF_SIGNED_CERT_IN_CHAIN. Strip URL sslmode and disable CA verification
 * for remote hosts so the TLS session still encrypts traffic.
 */
export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  let hostname = "";
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    hostname = "";
  }

  let cleaned = connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    url.searchParams.delete("schema");
    cleaned = url.toString();
  } catch {
    cleaned = connectionString;
  }

  return {
    connectionString: cleaned,
    max: 20,
    ssl: isLocalHost(hostname) ? false : { rejectUnauthorized: false },
  };
}

const DATABASE_URL = process.env.DATABASE_URL!;
const pool = new pg.Pool(postgresPoolConfig(DATABASE_URL));

export const db = drizzle(pool, { schema });
export { schema };
