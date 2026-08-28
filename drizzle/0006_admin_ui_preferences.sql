ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "ui_preferences" jsonb DEFAULT '{}'::jsonb;
