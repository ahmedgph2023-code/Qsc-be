-- Blotter unit cost (Buy/Sell Value ÷ qty) needs more than 4 dp so qty×price matches Gross.
ALTER TABLE "transactions" ALTER COLUMN "price" TYPE numeric(20, 10);
