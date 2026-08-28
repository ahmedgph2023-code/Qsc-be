import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL || "postgresql://qse:qse_password@localhost:5433/qse";
const parsed = new URL(url);
const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
const database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || "postgres");

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: isLocal
    ? { url }
    : {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database,
        ssl: { rejectUnauthorized: false },
      },
});
