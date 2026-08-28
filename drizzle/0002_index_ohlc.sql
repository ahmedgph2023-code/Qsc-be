ALTER TABLE "index_data_points" ADD COLUMN IF NOT EXISTS "open_value" numeric(15, 4);
ALTER TABLE "index_data_points" ADD COLUMN IF NOT EXISTS "high_value" numeric(15, 4);
ALTER TABLE "index_data_points" ADD COLUMN IF NOT EXISTS "low_value" numeric(15, 4);
