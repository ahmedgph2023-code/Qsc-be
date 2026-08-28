ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "source_import_id" uuid;
CREATE INDEX IF NOT EXISTS "idx_tx_source_import" ON "transactions" ("source_import_id");

ALTER TABLE "cash_transactions" ADD COLUMN IF NOT EXISTS "source_import_id" uuid;
CREATE INDEX IF NOT EXISTS "idx_cash_source_import" ON "cash_transactions" ("source_import_id");

DO $$ BEGIN
  CREATE TYPE "historical_import_kind" AS ENUM ('securities', 'prices', 'indices', 'client', 'trades', 'cash');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "historical_import_status" AS ENUM ('committed', 'replaced', 'deleted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "historical_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "historical_import_kind" NOT NULL,
  "status" "historical_import_status" DEFAULT 'committed' NOT NULL,
  "file_name" varchar(300) NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "customer_id" uuid,
  "portfolio_id" uuid,
  "client_key" varchar(80),
  "summary" jsonb,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "replaced_by_id" uuid
);

CREATE INDEX IF NOT EXISTS "idx_hist_import_kind_status" ON "historical_imports" ("kind", "status");
