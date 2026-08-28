/**
 * Compare live SQL statement 2041929 as-of 2024-12-01 to the trading PDF freeze.
 * Footer commission / Dr/Cr / NAV stay unknown. Header extras are KB-only for this NIN.
 */
import "dotenv/config";
import { getPortfolioStatement } from "../src/services/ext-sql-clients.js";
import { UAT_PORTFOLIO_2024_12_01, UAT_SAAD } from "../src/services/statement-uat.js";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  const p = UAT_PORTFOLIO_2024_12_01;
  const stmt = await getPortfolioStatement(UAT_SAAD.accountId, p.asOf);
  if (!stmt) {
    console.log(JSON.stringify({ error: "NO_STATEMENT" }, null, 2));
    process.exit(2);
  }
  const lines = stmt.sectors.flatMap((s) => s.lines);
  const mhar = lines.find((l) => l.ticker === p.ticker);
  console.log(JSON.stringify({
    asOf: stmt.dates.asOf,
    missingCloses: stmt.missingCloses,
    investor: {
      nin: stmt.investor.nin,
      poBox: stmt.investor.poBox,
      city: stmt.investor.city,
      country: stmt.investor.country,
      accountTypePrinted: stmt.investor.accountTypePrinted,
      fax: stmt.investor.fax,
      tradingAccountQe: stmt.investor.tradingAccountQe,
    },
    mhar: mhar
      ? {
          quantity: mhar.quantity,
          closePrice: mhar.closePrice,
          marketValue: mhar.marketValue,
          qtyMatch: mhar.quantity === p.quantity,
          closeMatch: mhar.closePrice === p.closePrice,
          mvMatch: mhar.marketValue === p.marketValue,
          costValue: mhar.costValue,
          costMatch: mhar.costValue != null && round2(mhar.costValue) === round2(p.costValue),
        }
      : null,
    footerStillUnknown: {
      expectedSellCommission: stmt.footer.expectedSellCommission.value == null,
      breakEven: mhar?.breakEven.value == null,
      netAssetValue: stmt.footer.netAssetValue.value == null,
      cashLedger: stmt.footer.cashLedgerBalance.value,
    },
  }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
