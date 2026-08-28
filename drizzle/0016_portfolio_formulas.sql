-- Super-admin Investment Portfolio formula catalog (Excel Table1 defaults).

CREATE TABLE IF NOT EXISTS "portfolio_formulas" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "label" varchar(160) NOT NULL,
  "category" varchar(40) NOT NULL DEFAULT 'row',
  "excel_formula" text NOT NULL,
  "expression" text NOT NULL,
  "inputs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "description" text,
  "updated_by" uuid,
  "updated_at" timestamptz DEFAULT now()
);
