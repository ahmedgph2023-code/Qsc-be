/**
 * Compare live SQL statement 2041929 as-of 2024-12-31 to KB year-end GISS checkpoint.
 * Usage: npx tsx scripts/verify-kb-year-end.ts
 * Does not invent NAV/commission. Footer stays unknown until QSC signs those rules.
 */
import "dotenv/config";
import { getPortfolioStatement } from "../src/services/ext-sql-clients.js";
import { UAT_KB_2024_12_31, UAT_SAAD } from "../src/services/statement-uat.js";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  const stmt = await getPortfolioStatement(UAT_SAAD.accountId, UAT_KB_2024_12_31.asOf);
  if (!stmt) {
    console.log(JSON.stringify({ error: "NO_STATEMENT" }, null, 2));
    process.exit(2);
  }
  const lines = stmt.sectors.flatMap((s) => s.lines);
  const giss = lines.find((l) => l.ticker === UAT_KB_2024_12_31.ticker);
  const cash = stmt.footer.cashLedgerBalance.value;
  const report = {
    asOf: stmt.dates.asOf,
    missingCloses: stmt.missingCloses,
    investor: {
      nin: stmt.investor.nin,
      poBox: stmt.investor.poBox,
      city: stmt.investor.city,
      country: stmt.investor.country,
      accountTypePrinted: stmt.investor.accountTypePrinted,
    },
    giss: giss
      ? {
          quantity: giss.quantity,
          closePrice: giss.closePrice,
          marketValue: giss.marketValue,
          qtyMatch: giss.quantity === UAT_KB_2024_12_31.quantity,
          closeMatch: giss.closePrice === UAT_KB_2024_12_31.close,
          mvMatch: giss.marketValue === UAT_KB_2024_12_31.marketValue,
        }
      : null,
    cash: {
      ledger: cash,
      kb: UAT_KB_2024_12_31.cash,
      match: cash != null && round2(cash) === round2(UAT_KB_2024_12_31.cash),
    },
    kbNavIsMvPlusCash: round2(UAT_KB_2024_12_31.marketValue + UAT_KB_2024_12_31.cash) === UAT_KB_2024_12_31.nav,
    statementNavStillUnknown: stmt.footer.netAssetValue.value == null,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
