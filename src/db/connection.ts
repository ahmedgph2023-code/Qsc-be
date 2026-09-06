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
 *
 * Local hosts and explicit sslmode=disable must never force TLS — a local
 * Postgres without SSL rejects the handshake with
 * "The server does not support SSL connections".
 */
export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  let hostname = "";
  let sslmode = "";
  let cleaned = connectionString;

  try {
    const url = new URL(connectionString);
    hostname = url.hostname;
    sslmode = (url.searchParams.get("sslmode") || "").toLowerCase();
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    url.searchParams.delete("schema");
    cleaned = url.toString();
  } catch {
    cleaned = connectionString;
    const match = connectionString.match(/[?&]sslmode=([^&]+)/i);
    sslmode = (match?.[1] || "").toLowerCase();
  }

  const disableSsl =
    isLocalHost(hostname) || sslmode === "disable" || sslmode === "false";

  return {
    connectionString: cleaned,
    max: 20,
    ssl: disableSsl ? false : { rejectUnauthorized: false },
  };
}

const DATABASE_URL = process.env.DATABASE_URL!;
const pool = new pg.Pool(postgresPoolConfig(DATABASE_URL));

export const db = drizzle(pool, { schema });
export { schema };
