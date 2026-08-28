-- Replace Group A/B/C with Shariah / Not Shariah.
ALTER TABLE "stocks" ALTER COLUMN "shariah_group" TYPE varchar(20);
UPDATE "stocks" SET "shariah_group" = 'shariah' WHERE "shariah_group" IN ('A', 'a');
UPDATE "stocks" SET "shariah_group" = 'not_shariah' WHERE "shariah_group" IN ('B', 'C', 'b', 'c');

-- Drop purifying: those mandates could hold B names, so they become unrestricted.
UPDATE "mandates" SET "shariah_preference" = 'unrestricted' WHERE "shariah_preference" = 'shariah_purifying';
