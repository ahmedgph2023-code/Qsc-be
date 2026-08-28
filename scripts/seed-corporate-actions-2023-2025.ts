/**
 * One-off seed script: inserts the cash-dividend corporate actions found in the
 * three QSE "AGM and EGM" proposed-dividend PDFs (historical-data/37808/التوزيعات
 * النقدية/) for every stock that currently exists in the `stocks` table.
 *
 * Source documents (fiscal years ended 31/12/2023, 31/12/2024, 31/12/2025):
 *   - AGM and EGM 31-12-2023.pdf
 *   - AGM and EGM-2024.pdf
 *   - AGM and EGM- 2025 - Copy.pdf
 *
 * Each row in those PDFs gives a cash dividend as a % of the share's nominal
 * (par) value. This system stores dividends as an absolute cash-per-share
 * amount (`corporate_actions.cash_amount`), so we convert:
 *
 *     cashAmount = (percentage / 100) * PAR_VALUE
 *
 * All six tickers below (ERES, GISS, IQCD, MCGS, MHAR, SIIS) are QSE main-market
 * shares with a QAR 1.00 nominal value, so PAR_VALUE = 1 unless overridden in
 * PAR_VALUE_OVERRIDES below.
 *
 * The action date used is the date the AGM actually convened (i.e. the
 * "alternate"/rescheduled date when the first-called meeting lacked quorum),
 * since that is when the distribution was formally endorsed.
 *
 * Safe to re-run: existing (stockId, actionDate, actionType) rows are skipped.
 *
 * Usage: npx tsx scripts/seed-corporate-actions-2023-2025.ts [--dry-run]
 */
import "dotenv/config";
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://qse:qse_password@localhost:5433/qse";
}

const { db, schema } = await import("../src/db/connection.js");
const { and, eq } = await import("drizzle-orm");
const { rebuildAdjustedPrices } = await import("../src/services/adjusted-prices.js");
const { applyCorporateActionToPortfolios } = await import("../src/services/corporate-action-portfolio.js");

const DRY_RUN = process.argv.includes("--dry-run");

const PAR_VALUE = 1; // QAR nominal value per share for these tickers
const PAR_VALUE_OVERRIDES: Record<string, number> = {
  // ticker: parValue  (add here if any of these ever turns out to differ from QAR 1)
};

interface CaRow {
  ticker: string;
  actionDate: string; // YYYY-MM-DD, AGM-held date
  pctOfPar: number; // cash dividend as % of nominal value
  fiscalYear: number;
}

const DIVIDENDS: CaRow[] = [
  // IQCD — Industries Qatar
  { ticker: "IQCD", fiscalYear: 2023, actionDate: "2024-03-20", pctOfPar: 78 },
  { ticker: "IQCD", fiscalYear: 2024, actionDate: "2025-02-25", pctOfPar: 74 },
  { ticker: "IQCD", fiscalYear: 2025, actionDate: "2026-03-10", pctOfPar: 71 },

  // MCGS — Medicare Group
  { ticker: "MCGS", fiscalYear: 2023, actionDate: "2024-04-01", pctOfPar: 22 },
  { ticker: "MCGS", fiscalYear: 2024, actionDate: "2025-04-16", pctOfPar: 19.8 },
  { ticker: "MCGS", fiscalYear: 2025, actionDate: "2026-03-31", pctOfPar: 22 },

  // GISS — Gulf International Services
  { ticker: "GISS", fiscalYear: 2023, actionDate: "2024-03-27", pctOfPar: 15 },
  { ticker: "GISS", fiscalYear: 2024, actionDate: "2025-02-27", pctOfPar: 17 },
  { ticker: "GISS", fiscalYear: 2025, actionDate: "2026-02-26", pctOfPar: 10 },

  // SIIS — Salam International Investment
  { ticker: "SIIS", fiscalYear: 2023, actionDate: "2024-03-05", pctOfPar: 3 },
  { ticker: "SIIS", fiscalYear: 2024, actionDate: "2025-03-11", pctOfPar: 4 },
  { ticker: "SIIS", fiscalYear: 2025, actionDate: "2026-03-29", pctOfPar: 6 },

  // MHAR — Al Mahhar Holding (not covered in the FY2023 document)
  { ticker: "MHAR", fiscalYear: 2024, actionDate: "2025-04-13", pctOfPar: 12 },
  { ticker: "MHAR", fiscalYear: 2025, actionDate: "2026-04-15", pctOfPar: 15 },

  // ERES — Ezdan Holding Group proposed NO dividend in any of the 3 fiscal
  // years covered by these documents, so there is nothing to seed for it.
];

async function main() {
  const stocks = await db.select().from(schema.stocks);
  const byTicker = new Map(stocks.map((s) => [s.ticker, s]));

  console.log(`Found ${stocks.length} stocks in DB: ${stocks.map((s) => s.ticker).join(", ")}`);
  console.log(`Seeding ${DIVIDENDS.length} dividend corporate actions${DRY_RUN ? " (DRY RUN)" : ""}...\n`);

  const touchedStockIds = new Set<string>();
  let inserted = 0;
  let skippedExisting = 0;
  let skippedMissingStock = 0;

  for (const row of DIVIDENDS) {
    const stock = byTicker.get(row.ticker);
    if (!stock) {
      console.warn(`  [skip] ${row.ticker} FY${row.fiscalYear}: ticker not found in stocks table`);
      skippedMissingStock++;
      continue;
    }

    const par = PAR_VALUE_OVERRIDES[row.ticker] ?? PAR_VALUE;
    const cashAmount = Math.round(((row.pctOfPar / 100) * par) * 10000) / 10000;

    const existing = await db
      .select()
      .from(schema.corporateActions)
      .where(
        and(
          eq(schema.corporateActions.stockId, stock.id),
          eq(schema.corporateActions.actionDate, row.actionDate),
          eq(schema.corporateActions.actionType, "DIVIDEND"),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`  [skip] ${row.ticker} ${row.actionDate}: already exists (id ${existing[0].id})`);
      skippedExisting++;
      continue;
    }

    console.log(
      `  [add]  ${row.ticker} FY${row.fiscalYear}: DIVIDEND ${row.pctOfPar}% of par -> QAR ${cashAmount}/share on ${row.actionDate}`,
    );

    if (DRY_RUN) continue;

    const [created] = await db
      .insert(schema.corporateActions)
      .values({
        stockId: stock.id,
        actionDate: row.actionDate,
        actionType: "DIVIDEND",
        ratio: null,
        cashAmount: String(cashAmount),
      })
      .returning();

    touchedStockIds.add(stock.id);
    inserted++;

    // Mirrors what the POST /stocks/:id/corporate-actions route does:
    // apply cash to every portfolio holding the stock as of the action date.
    const impact = await applyCorporateActionToPortfolios(created.id);
    if (impact.portfoliosAffected > 0) {
      console.log(
        `         -> applied to ${impact.portfoliosAffected} portfolio(s), total cash posted QAR ${impact.totalCashPosted}`,
      );
    }
  }

  if (!DRY_RUN) {
    for (const stockId of touchedStockIds) {
      await rebuildAdjustedPrices(stockId);
    }
  }

  console.log(
    `\nDone. Inserted ${inserted}, skipped ${skippedExisting} existing, ${skippedMissingStock} unknown ticker(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
