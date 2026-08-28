-- One corporate-action booking per client per stock / date / type / amount (cash + qty).
DELETE FROM corporate_action_applications a
USING corporate_action_applications b
WHERE a.portfolio_id = b.portfolio_id
  AND a.stock_id = b.stock_id
  AND a.action_date = b.action_date
  AND a.action_type = b.action_type
  AND a.cash_amount = b.cash_amount
  AND a.qty_delta = b.qty_delta
  AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));

CREATE UNIQUE INDEX IF NOT EXISTS "idx_ca_app_client_date_type_amount"
ON "corporate_action_applications" (
  "portfolio_id",
  "stock_id",
  "action_date",
  "action_type",
  "cash_amount",
  "qty_delta"
);
