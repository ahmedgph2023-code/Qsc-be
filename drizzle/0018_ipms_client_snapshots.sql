-- Cloudilic daily snapshot (D-015). QSC writes ClientPortfolioSnapshot in SQL;
-- we never write that table. History is kept here even if SQL keeps only the latest day.

CREATE TABLE IF NOT EXISTS "ipms_client_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" integer NOT NULL,
  "snapshot_date" date NOT NULL,
  "nin" varchar(32),
  "name" varchar(300),
  "ipms_market_value" numeric(18, 4),
  "ipms_cash" numeric(18, 4) NOT NULL,
  "ipms_nav_mv_plus_cash" numeric(18, 4),
  "missing_closes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "qsc_portfolio_value" numeric(18, 4),
  "qsc_system_cash" numeric(18, 4),
  "qsc_bank_balance" numeric(18, 4),
  "qsc_updated_at" timestamptz,
  "cash_match" boolean,
  "mv_match" boolean,
  "nav_match" boolean,
  "status" varchar(20) NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ipms_client_snapshots_client_date"
  ON "ipms_client_snapshots" ("client_id", "snapshot_date");
CREATE INDEX IF NOT EXISTS "ipms_client_snapshots_date"
  ON "ipms_client_snapshots" ("snapshot_date");
CREATE INDEX IF NOT EXISTS "ipms_client_snapshots_status"
  ON "ipms_client_snapshots" ("status");
