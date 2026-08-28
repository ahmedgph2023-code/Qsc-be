import { blotterForPeriod } from "./realized-blotter.js";
import {
  QSC_STATEMENT_COMPANY,
  unknownMoney,
  type RealizedSummaryStatement,
  type StatementDateControl,
  type StatementInvestorHeader,
} from "./statement-types.js";
import type { ExtShareRow } from "./ext-sql-portfolio.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function assembleRealizedSummary(input: {
  dates: StatementDateControl;
  investor: StatementInvestorHeader;
  shares: ExtShareRow[];
  printedAtIso: string;
}): RealizedSummaryStatement {
  const from = input.dates.mode === "range" ? input.dates.from : "0000-01-01";
  const to = input.dates.mode === "range" ? input.dates.to : input.dates.asOf;
  const groups = blotterForPeriod(input.shares, from, to);
  const lines = groups.map((g) => {
    const tradingProfit = round4(g.lines.reduce((s, l) => s + l.dayResult, 0));
    return {
      companyName: g.companyName,
      ticker: g.ticker,
      compId: g.compId,
      accountTypePrinted: null as string | null,
      tradingProfit,
      distributedDividends: unknownMoney("DIVIDEND_SOURCE"),
      nonReceivedDividends: unknownMoney("DIVIDEND_SOURCE"),
      totalProfit: unknownMoney("DIVIDEND_SOURCE"),
    };
  });
  const tradingProfitTotal = round4(lines.reduce((s, l) => s + l.tradingProfit, 0));
  return {
    kind: "realized_summary",
    titleEn: "Realized Profit/loss Summary",
    titleAr: "كشف الأرباح والخسائر المحققة — مختصر",
    company: QSC_STATEMENT_COMPANY,
    investor: input.investor,
    dates: input.dates,
    lines,
    tradingProfitTotal,
    footer: {
      commission: unknownMoney("PNL_FOOTER_RULE"),
      endOfPeriodBalance: unknownMoney("PNL_FOOTER_RULE"),
      drCrBalance: unknownMoney("DR_CR_VS_CASH"),
      paidCapital: unknownMoney("PNL_FOOTER_RULE"),
      footerTotal: unknownMoney("PNL_FOOTER_RULE"),
      realizedProfitLoss: { value: tradingProfitTotal, source: "engine" },
      expectedProfitLoss: unknownMoney("EXPECTED_SELL_COMM_RULE"),
      netProfitLoss: unknownMoney("EXPECTED_SELL_COMM_RULE"),
      profitLossPercentage: unknownMoney("PNL_PCT_RULE"),
      receivedProfits: unknownMoney("DIVIDEND_SOURCE"),
      nonReceivedProfits: unknownMoney("DIVIDEND_SOURCE"),
    },
    print: { printedAtIso: input.printedAtIso, page: null },
  };
}
