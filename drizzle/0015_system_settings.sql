-- Super-admin system settings (feature flags / product toggles). IPS numbers stay in ips_limit_config.

CREATE TABLE IF NOT EXISTS "system_settings" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "value" varchar(200) NOT NULL,
  "value_type" varchar(20) NOT NULL DEFAULT 'boolean',
  "category" varchar(40) NOT NULL DEFAULT 'flags',
  "description" text,
  "confirmed" boolean NOT NULL DEFAULT false,
  "source" varchar(80) NOT NULL DEFAULT 'blueprint_default',
  "updated_by" uuid,
  "updated_at" timestamptz DEFAULT now()
);
