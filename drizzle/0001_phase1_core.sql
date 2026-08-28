CREATE TYPE "public"."impact" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('STRONG_BUY', 'BUY', 'HOLD', 'REDUCE', 'EXIT');--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('POSITIVE', 'NEUTRAL', 'NEGATIVE');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'in_progress', 'resolved', 'waived');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'approve', 'reject', 'status_change', 'override', 'login', 'export', 'correction');--> statement-breakpoint
CREATE TYPE "public"."builder_target_type" AS ENUM('model', 'client');--> statement-breakpoint
CREATE TYPE "public"."cash_tx_type" AS ENUM('deposit', 'withdrawal', 'fee', 'dividend', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."check_result" AS ENUM('pass', 'fail', 'warning');--> statement-breakpoint
CREATE TYPE "public"."compliance_timing" AS ENUM('before_proposal', 'before_trade', 'after_trade');--> statement-breakpoint
CREATE TYPE "public"."construction_style" AS ENUM('core_satellite', 'full_active');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('requested', 'approved', 'rejected', 'expired', 'used');--> statement-breakpoint
CREATE TYPE "public"."mandate_approval_status" AS ENUM('pending', 'approved', 'amended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."mandate_type" AS ENUM('discretionary');--> statement-breakpoint
CREATE TYPE "public"."model_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."rebalance_lock_status" AS ENUM('draft', 'approved', 'executed', 'final', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rebalance_trigger" AS ENUM('quarterly_review', 'benchmark_change', 'active_review', 'breach', 'cash_deposit', 'cash_withdrawal', 'ad_hoc');--> statement-breakpoint
CREATE TYPE "public"."restriction_type" AS ENUM('stock', 'sector', 'other');--> statement-breakpoint
CREATE TYPE "public"."risk_alert_type" AS ENUM('stock_weight_15', 'stock_weight_20', 'sector_weight_35', 'sector_weight_40', 'stock_loss_15', 'stock_loss_25', 'stock_loss_30', 'underperform_3m', 'excess_cash', 'liquidity', 'regulatory');--> statement-breakpoint
CREATE TYPE "public"."risk_profile" AS ENUM('medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."shariah_preference" AS ENUM('fully_shariah', 'shariah_purifying', 'unrestricted');--> statement-breakpoint
CREATE TABLE "news_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"news_id" uuid NOT NULL,
	"sector" varchar(200),
	"sentiment" "sentiment" NOT NULL,
	"impact" "impact" NOT NULL,
	"confidence" integer NOT NULL,
	"summary" text,
	"key_drivers" text,
	"risks" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "news_analysis_news_id_unique" UNIQUE("news_id")
);
--> statement-breakpoint
CREATE TABLE "news_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_id" uuid,
	"title" text NOT NULL,
	"content" text,
	"source" varchar(200),
	"url" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "news_articles_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "sector_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_id" uuid NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"score" numeric(8, 4) NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"positive_drivers" text,
	"top_risks" text,
	"explanation" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sector_recommendations_sector_id_unique" UNIQUE("sector_id")
);
--> statement-breakpoint
CREATE TABLE "sector_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_id" uuid NOT NULL,
	"sentiment_score" numeric(8, 4) NOT NULL,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"neutral_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"total_articles" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sector_scores_sector_id_unique" UNIQUE("sector_id")
);
--> statement-breakpoint
CREATE TABLE "sectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"keywords" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sectors_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" "audit_action" NOT NULL,
	"object_type" varchar(64) NOT NULL,
	"object_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"ip_address" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "builder_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "builder_target_type" NOT NULL,
	"model_portfolio_id" uuid,
	"portfolio_id" uuid,
	"mandate_id" uuid,
	"status" varchar(40) DEFAULT 'drafting' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cash_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"type" "cash_tx_type" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"trade_date" date NOT NULL,
	"value_date" date,
	"reference" varchar(100),
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "compliance_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"check_code" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"status" "exception_status" DEFAULT 'requested' NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"valid_until" date,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "compliance_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rebalance_id" uuid,
	"portfolio_id" uuid,
	"check_code" varchar(64) NOT NULL,
	"timing" "compliance_timing" DEFAULT 'before_proposal' NOT NULL,
	"result" "check_result" NOT NULL,
	"reason_code" varchar(64),
	"message" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "index_constituents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index_id" uuid NOT NULL,
	"stock_id" uuid NOT NULL,
	"weight" numeric(12, 8) NOT NULL,
	"effective_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ips_limit_config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" numeric(18, 8) NOT NULL,
	"unit" varchar(20) DEFAULT 'ratio' NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "mandate_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandate_id" uuid NOT NULL,
	"restriction_type" "restriction_type" NOT NULL,
	"stock_id" uuid,
	"sector" varchar(100),
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mandate_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandate_id" uuid NOT NULL,
	"from_status" "mandate_approval_status",
	"to_status" "mandate_approval_status" NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"mandate_type" "mandate_type" DEFAULT 'discretionary' NOT NULL,
	"shariah_preference" "shariah_preference" NOT NULL,
	"risk_profile" "risk_profile" NOT NULL,
	"benchmark_index_id" uuid,
	"model_portfolio_id" uuid,
	"approval_status" "mandate_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"contract_start" date,
	"contract_end" date,
	"initial_value" numeric(18, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "mandates_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "model_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_portfolio_id" uuid NOT NULL,
	"stock_id" uuid NOT NULL,
	"target_weight" numeric(12, 8) NOT NULL,
	"sleeve" varchar(20) DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(200) NOT NULL,
	"shariah_preference" "shariah_preference" NOT NULL,
	"risk_profile" "risk_profile" NOT NULL,
	"benchmark_index_id" uuid,
	"construction_style" "construction_style" NOT NULL,
	"core_weight" numeric(8, 4) DEFAULT '0.65' NOT NULL,
	"satellite_weight" numeric(8, 4) DEFAULT '0.35' NOT NULL,
	"status" "model_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "model_portfolios_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "rebalance_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rebalance_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"corrected_by" uuid,
	"corrected_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rebalance_proposed_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rebalance_id" uuid NOT NULL,
	"stock_id" uuid NOT NULL,
	"side" varchar(10) NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"estimated_price" numeric(18, 4),
	"estimated_value" numeric(18, 4),
	"reason" text,
	"compliance_result" "check_result"
);
--> statement-breakpoint
CREATE TABLE "rebalances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rebalance_code" varchar(40) NOT NULL,
	"portfolio_id" uuid,
	"model_portfolio_id" uuid,
	"trigger" "rebalance_trigger" DEFAULT 'ad_hoc' NOT NULL,
	"lock_status" "rebalance_lock_status" DEFAULT 'draft' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now(),
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"prepared_by" uuid,
	"reviewed_by" uuid,
	"approved_by" uuid,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"target_allocation" jsonb,
	"compliance_summary" jsonb,
	"allocation_method" varchar(40),
	"documents" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rebalances_rebalance_code_unique" UNIQUE("rebalance_code")
);
--> statement-breakpoint
CREATE TABLE "risk_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"alert_type" "risk_alert_type" NOT NULL,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"stock_id" uuid,
	"sector" varchar(100),
	"metric_value" numeric(18, 8),
	"threshold" numeric(18, 8),
	"due_date" date,
	"owner_id" uuid,
	"resolution_notes" text,
	"opened_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "display_name" varchar(200);--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "role" varchar(40) DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "account_number" varchar(50);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "portfolio_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "model_portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "base_currency" varchar(3) DEFAULT 'QAR' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "cash_balance" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "inception_date" date;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "shariah_group" varchar(1);--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "is_qeri_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "is_dsm_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "avg_daily_traded_value" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "is_illiquid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "regulatory_status" varchar(20) DEFAULT 'clear' NOT NULL;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "regulatory_notes" text;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "is_tradable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stocks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "rebalance_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "commission" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "news_analysis" ADD CONSTRAINT "news_analysis_news_id_news_articles_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_articles" ADD CONSTRAINT "news_articles_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_recommendations" ADD CONSTRAINT "sector_recommendations_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_scores" ADD CONSTRAINT "sector_scores_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_restrictions" ADD CONSTRAINT "mandate_restrictions_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_status_history" ADD CONSTRAINT "mandate_status_history_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_holdings" ADD CONSTRAINT "model_holdings_model_portfolio_id_model_portfolios_id_fk" FOREIGN KEY ("model_portfolio_id") REFERENCES "public"."model_portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebalance_corrections" ADD CONSTRAINT "rebalance_corrections_rebalance_id_rebalances_id_fk" FOREIGN KEY ("rebalance_id") REFERENCES "public"."rebalances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebalance_proposed_trades" ADD CONSTRAINT "rebalance_proposed_trades_rebalance_id_rebalances_id_fk" FOREIGN KEY ("rebalance_id") REFERENCES "public"."rebalances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analysis_sector" ON "news_analysis" USING btree ("sector");--> statement-breakpoint
CREATE INDEX "idx_news_sector" ON "news_articles" USING btree ("sector_id");--> statement-breakpoint
CREATE INDEX "idx_news_published" ON "news_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "idx_audit_occurred" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_object" ON "audit_logs" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "idx_cash_portfolio_date" ON "cash_transactions" USING btree ("portfolio_id","trade_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_constituent_unique" ON "index_constituents" USING btree ("index_id","stock_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_holding_unique" ON "model_holdings" USING btree ("model_portfolio_id","stock_id");--> statement-breakpoint
CREATE INDEX "idx_rebalance_portfolio" ON "rebalances" USING btree ("portfolio_id","lock_status");--> statement-breakpoint
CREATE INDEX "idx_risk_alerts_open" ON "risk_alerts" USING btree ("portfolio_id","status");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_portfolio_manager_id_admins_id_fk" FOREIGN KEY ("portfolio_manager_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;