-- Phase 2: OMS orders/fills, block groups, report releases, reconciliation runs, CA type extensions

ALTER TYPE "corporate_action_type" ADD VALUE IF NOT EXISTS 'RIGHTS';
ALTER TYPE "corporate_action_type" ADD VALUE IF NOT EXISTS 'CAPITAL_REDUCTION';
ALTER TYPE "corporate_action_type" ADD VALUE IF NOT EXISTS 'MERGER_NAME_CHANGE';

CREATE TYPE "order_side" AS ENUM ('BUY', 'SELL');
CREATE TYPE "order_status" AS ENUM ('draft', 'approved', 'sent', 'partial', 'filled', 'cancelled', 'rejected');
CREATE TYPE "allocation_method" AS ENUM ('pro_rata', 'model_based', 'cash_based', 'exception');
CREATE TYPE "report_kind" AS ENUM ('client_monthly', 'aum_monthly', 'ic_quarterly');
CREATE TYPE "report_release_status" AS ENUM ('draft', 'pending_recon', 'released', 'blocked');
CREATE TYPE "recon_status" AS ENUM ('open', 'explained', 'cleared');

CREATE TABLE IF NOT EXISTS "oms_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portfolio_id" uuid NOT NULL,
  "stock_id" uuid NOT NULL,
  "side" "order_side" NOT NULL,
  "quantity" numeric(18, 4) NOT NULL,
  "limit_price" numeric(18, 6),
  "broker" varchar(120),
  "reason" text,
  "status" "order_status" NOT NULL DEFAULT 'draft',
  "rebalance_id" uuid,
  "block_group_id" uuid,
  "filled_quantity" numeric(18, 4) NOT NULL DEFAULT '0',
  "avg_fill_price" numeric(18, 6),
  "commission" numeric(18, 4) NOT NULL DEFAULT '0',
  "created_by" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_oms_orders_portfolio" ON "oms_orders" ("portfolio_id");
CREATE INDEX IF NOT EXISTS "idx_oms_orders_status" ON "oms_orders" ("status");
CREATE INDEX IF NOT EXISTS "idx_oms_orders_block" ON "oms_orders" ("block_group_id");

CREATE TABLE IF NOT EXISTS "oms_fills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "oms_orders"("id") ON DELETE CASCADE,
  "fill_qty" numeric(18, 4) NOT NULL,
  "fill_price" numeric(18, 6) NOT NULL,
  "commission" numeric(18, 4) NOT NULL DEFAULT '0',
  "filled_at" timestamptz NOT NULL DEFAULT now(),
  "transaction_id" uuid,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_oms_fills_order" ON "oms_fills" ("order_id");

CREATE TABLE IF NOT EXISTS "oms_block_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL,
  "side" "order_side" NOT NULL,
  "allocation_method" "allocation_method" NOT NULL DEFAULT 'pro_rata',
  "exception_reason" text,
  "exception_approved_by" uuid,
  "status" varchar(40) NOT NULL DEFAULT 'open',
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "report_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "report_kind" NOT NULL,
  "period_label" varchar(40) NOT NULL,
  "portfolio_id" uuid,
  "status" "report_release_status" NOT NULL DEFAULT 'draft',
  "payload" jsonb,
  "recon_run_id" uuid,
  "released_by" uuid,
  "released_at" timestamptz,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "as_of" date NOT NULL,
  "status" "recon_status" NOT NULL DEFAULT 'open',
  "cash_diff" numeric(18, 4) NOT NULL DEFAULT '0',
  "holdings_diff_count" integer NOT NULL DEFAULT 0,
  "notes" text,
  "explanation" text,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "snapshot" jsonb,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ops_form_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "form_code" varchar(10) NOT NULL,
  "mandate_id" uuid,
  "portfolio_id" uuid,
  "payload" jsonb,
  "status" varchar(40) NOT NULL DEFAULT 'draft',
  "created_by" uuid,
  "approved_by" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ops_form_code" ON "ops_form_events" ("form_code");
