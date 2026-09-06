CREATE TABLE IF NOT EXISTS "client_report_global_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "scheduling_enabled" boolean DEFAULT true NOT NULL,
  "data_sections" jsonb DEFAULT '["portfolio_statement","balance_snapshot"]'::jsonb NOT NULL,
  "frequency_type" "client_report_frequency" DEFAULT 'daily' NOT NULL,
  "custom_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
  "send_time" varchar(5) DEFAULT '09:00' NOT NULL,
  "as_of_mode" varchar(32) DEFAULT 'latest' NOT NULL,
  "range_days" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now()
);

INSERT INTO "client_report_global_settings" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;
