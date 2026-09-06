DO $$ BEGIN
  CREATE TYPE "client_report_frequency" AS ENUM('daily', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "client_report_send_status" AS ENUM('pending', 'sent', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "client_report_trigger" AS ENUM('scheduled', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "client_report_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ext_client_id" integer NOT NULL,
  "client_name" varchar(300),
  "enabled" boolean DEFAULT false NOT NULL,
  "recipient_email" varchar(320),
  "data_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "frequency_type" "client_report_frequency" DEFAULT 'daily' NOT NULL,
  "custom_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "send_time" varchar(5) DEFAULT '09:00' NOT NULL,
  "as_of_mode" varchar(32) DEFAULT 'latest' NOT NULL,
  "range_days" integer DEFAULT 1 NOT NULL,
  "last_sent_at" timestamp with time zone,
  "next_scheduled_at" timestamp with time zone,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "client_report_configs_ext_client_id_unique" UNIQUE("ext_client_id")
);

CREATE INDEX IF NOT EXISTS "idx_client_report_configs_enabled" ON "client_report_configs" ("enabled");
CREATE INDEX IF NOT EXISTS "idx_client_report_configs_next" ON "client_report_configs" ("next_scheduled_at");

CREATE TABLE IF NOT EXISTS "client_report_send_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "config_id" uuid NOT NULL,
  "ext_client_id" integer NOT NULL,
  "trigger_type" "client_report_trigger" NOT NULL,
  "status" "client_report_send_status" DEFAULT 'pending' NOT NULL,
  "error_message" text,
  "payload" jsonb,
  "sent_at" timestamp with time zone DEFAULT now(),
  "sent_by" uuid,
  CONSTRAINT "client_report_send_log_config_id_fkey"
    FOREIGN KEY ("config_id") REFERENCES "client_report_configs"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_client_report_send_log_config" ON "client_report_send_log" ("config_id");
CREATE INDEX IF NOT EXISTS "idx_client_report_send_log_client" ON "client_report_send_log" ("ext_client_id");
