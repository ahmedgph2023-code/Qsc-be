-- Phase 3: Approved List, five-layer research, Sharia/ESG reviews, strategies, advisory scores

CREATE TYPE "approved_list_status" AS ENUM (
  'approved_buy', 'hold', 'sell_only', 'watchlist', 'restricted'
);

CREATE TYPE "research_layer" AS ENUM (
  'macro', 'fundamental', 'valuation', 'internal', 'technical'
);

CREATE TYPE "research_layer_status" AS ENUM (
  'incomplete', 'pass', 'watch', 'fail'
);

CREATE TYPE "strategy_approval_status" AS ENUM (
  'draft', 'pending_ic', 'approved', 'retired'
);

CREATE TABLE IF NOT EXISTS "stock_approved_list" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL UNIQUE,
  "status" "approved_list_status" NOT NULL DEFAULT 'watchlist',
  "notes" text,
  "changed_by" uuid,
  "changed_at" timestamptz DEFAULT now(),
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_approved_list_status" ON "stock_approved_list" ("status");

CREATE TABLE IF NOT EXISTS "research_layer_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL,
  "layer" "research_layer" NOT NULL,
  "status" "research_layer_status" NOT NULL DEFAULT 'incomplete',
  "notes" text,
  "analyst_name" varchar(200),
  "assessed_at" date,
  "evidence_url" text,
  "updated_by" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  UNIQUE ("stock_id", "layer")
);

CREATE INDEX IF NOT EXISTS "idx_research_layers_stock" ON "research_layer_assessments" ("stock_id");

CREATE TABLE IF NOT EXISTS "research_layer_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "status" varchar(40) NOT NULL DEFAULT 'pending',
  "requested_by" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sharia_esg_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL,
  "shariah_group" varchar(20),
  "review_date" date,
  "reviewer_name" varchar(200),
  "evidence_notes" text,
  "esg_score" varchar(40),
  "esg_notes" text,
  "sync_to_stock" boolean NOT NULL DEFAULT false,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_sharia_esg_stock" ON "sharia_esg_reviews" ("stock_id");

CREATE TABLE IF NOT EXISTS "investment_strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_code" varchar(40) NOT NULL UNIQUE,
  "title" varchar(200) NOT NULL,
  "body" text,
  "parameters" jsonb,
  "positioning_notes" text,
  "approval_status" "strategy_approval_status" NOT NULL DEFAULT 'draft',
  "effective_from" date,
  "effective_to" date,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "stock_score_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(120) NOT NULL DEFAULT 'default',
  "factors" jsonb,
  "confirmed" boolean NOT NULL DEFAULT false,
  "notes" text,
  "updated_by" uuid,
  "updated_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "stock_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stock_id" uuid NOT NULL UNIQUE,
  "score" numeric(10, 4),
  "rank" integer,
  "breakdown" jsonb,
  "as_of" date,
  "updated_at" timestamptz DEFAULT now()
);
