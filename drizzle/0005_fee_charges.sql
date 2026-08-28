ALTER TYPE "public"."cash_tx_type" ADD VALUE IF NOT EXISTS 'commission_rebate';

DO $$ BEGIN
  CREATE TYPE "public"."performance_frequency" AS ENUM ('annual', 'quarterly');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fee_charge_type" AS ENUM ('rebate_commission', 'management_fee', 'performance_fee');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fee_charge_status" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "mandate_fee_bands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandate_id" uuid NOT NULL REFERENCES "mandates"("id") ON DELETE CASCADE,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "rebate_commission_pct" numeric(12, 6) NOT NULL DEFAULT '0',
  "annual_management_fee_pct" numeric(12, 6) NOT NULL DEFAULT '0',
  "performance_fee_pct" numeric(12, 6) NOT NULL DEFAULT '0',
  "performance_frequency" "performance_frequency" NOT NULL DEFAULT 'annual',
  "performance_hurdle_pct" numeric(12, 6) NOT NULL DEFAULT '0',
  "high_water_mark" numeric(18, 4) NOT NULL DEFAULT '0',
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_fee_bands_mandate" ON "mandate_fee_bands" ("mandate_id", "effective_from");

CREATE TABLE IF NOT EXISTS "fee_charges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portfolio_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "mandate_id" uuid NOT NULL,
  "fee_band_id" uuid,
  "type" "fee_charge_type" NOT NULL,
  "period_month" date NOT NULL,
  "period_end_date" date NOT NULL,
  "notional" numeric(18, 4) NOT NULL DEFAULT '0',
  "holdings_mv" numeric(18, 4) NOT NULL DEFAULT '0',
  "cash_as_of" numeric(18, 4) NOT NULL DEFAULT '0',
  "nav" numeric(18, 4) NOT NULL DEFAULT '0',
  "rate_pct" numeric(12, 6) NOT NULL DEFAULT '0',
  "amount" numeric(18, 4) NOT NULL DEFAULT '0',
  "hwm_before" numeric(18, 4),
  "excess" numeric(18, 4),
  "twr_pct" numeric(12, 6),
  "status" "fee_charge_status" NOT NULL DEFAULT 'pending',
  "cash_transaction_id" uuid,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "rejected_by" uuid,
  "rejected_at" timestamp with time zone,
  "decision_reason" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_fee_charge_unique" ON "fee_charges" ("portfolio_id", "period_month", "type");
CREATE INDEX IF NOT EXISTS "idx_fee_charges_status" ON "fee_charges" ("status", "period_month");
