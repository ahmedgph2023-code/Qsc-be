-- Phase 4: AI governance, commentary drafts, named scenarios, efficient frontier runs

CREATE TYPE "ai_prompt_type" AS ENUM (
  'portfolio_summary',
  'risk_summary',
  'compliance_summary',
  'research_draft',
  'commentary_draft',
  'rebalance_explain',
  'ticker_ideas'
);

CREATE TYPE "commentary_status" AS ENUM (
  'draft', 'edited', 'accepted', 'rejected', 'released'
);

CREATE TYPE "scenario_kind" AS ENUM (
  'multi_trade', 'price_shock', 'liquidity_stress', 'cash_deploy', 'benchmark_relative'
);

CREATE TABLE IF NOT EXISTS "ai_governance_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prompt_type" "ai_prompt_type" NOT NULL,
  "model" varchar(80) NOT NULL DEFAULT 'template',
  "user_id" uuid,
  "object_type" varchar(80),
  "object_id" uuid,
  "prompt_hash" varchar(64),
  "output_ref" text,
  "accepted" boolean,
  "disclosure" varchar(120) NOT NULL DEFAULT 'AI draft — not an approval',
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ai_gov_created" ON "ai_governance_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_ai_gov_user" ON "ai_governance_logs" ("user_id");

CREATE TABLE IF NOT EXISTS "commentary_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "report_release_id" uuid,
  "kind" varchar(40) NOT NULL,
  "period_label" varchar(40),
  "portfolio_id" uuid,
  "body" text NOT NULL,
  "status" "commentary_status" NOT NULL DEFAULT 'draft',
  "ai_log_id" uuid,
  "created_by" uuid,
  "reviewed_by" uuid,
  "reviewed_at" timestamptz,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_commentary_status" ON "commentary_drafts" ("status");

CREATE TABLE IF NOT EXISTS "scenario_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(200),
  "kind" "scenario_kind" NOT NULL,
  "portfolio_id" uuid NOT NULL,
  "params" jsonb,
  "result" jsonb,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_scenario_portfolio" ON "scenario_runs" ("portfolio_id");

CREATE TABLE IF NOT EXISTS "efficient_frontier_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portfolio_id" uuid NOT NULL,
  "mandate_id" uuid,
  "methodology" varchar(80) NOT NULL DEFAULT 'unconfirmed_equal_risk',
  "assumptions" jsonb,
  "params" jsonb,
  "result" jsonb,
  "status" varchar(40) NOT NULL DEFAULT 'completed',
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now()
);
