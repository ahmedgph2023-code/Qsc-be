ALTER TYPE "public"."cash_tx_type" ADD VALUE IF NOT EXISTS 'trade_buy';
ALTER TYPE "public"."cash_tx_type" ADD VALUE IF NOT EXISTS 'trade_sell';
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "cash_balance_after" numeric(18, 4);
ALTER TABLE "cash_transactions" ADD COLUMN IF NOT EXISTS "stock_transaction_id" uuid;
