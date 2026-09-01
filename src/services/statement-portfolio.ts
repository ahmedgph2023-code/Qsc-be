import { applyReplayEvents } from "./holdings-replay.js";
import {
  cashBalance,
  companyNameFromShare,
  eventsFromShares,
  realizedFromEvents,
  type ExtCashRow,
  type ExtShareRow,
} from "./ext-sql-portfolio.js";
import {
  QSC_STATEMENT_COMPANY,
  buildInvestorHeader,
  engineMoney,
  sqlMoney,
  unknownMoney,
  type PortfolioStatement,
  type PortfolioStatementLine,
  type PortfolioStatementSector,
  type StatementInvestorHeader,
} from "./statement-types.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const roundPct = (n: number) => Math.round(n * 1_000_000) / 10_000;

/** Client answer 2026-08-30 (س-01): expected sell commission rate on market value. */
export const EXPECTED_SELL_COMM_RATE = 0.00275;

function expectedSellCommissionOnMv(marketValue: number): number {
  return round4(marketValue * EXPECTED_SELL_COMM_RATE);
}

/** Client answer 2026-08-30 (س-02): sell price where expected P/L is zero after sell commission. */
export function breakEvenFromAvgCost(avgCost: number): number {
  return round4(avgCost / (1 - EXPECTED_SELL_COMM_RATE));
}

export type OfficialClose = {
  price: number;
  date: string;
};

export type PortfolioLot = {
  ticker: string;
  companyName: string;
  sector: string;
  compId: number | null;
  quantity: number;
  totalCost: number;
  avgCost: number;
};

export function lotsFromShares(shares: ExtShareRow[], asOf: string, sectors: Map<string, string>, companyNames: Map<string, string>): PortfolioLot[] {
  const events = eventsFromShares(shares, asOf);
  const positions = applyReplayEvents(events);
  const lots: PortfolioLot[] = [];
  for (const [ticker, pos] of positions) {
    if (pos.quantity <= 0.0001) continue;
    lots.push({
      ticker,
      companyName: companyNames.get(ticker) || companyNameFromShare(shares, ticker),
      sector: sectors.get(ticker) || "Unclassified",
      compId: shares.find((s) => s.tickerId.trim() === ticker && s.compId != null)?.compId ?? null,
      quantity: round4(pos.quantity),
      totalCost: round4(pos.totalCost),
      avgCost: pos.quantity > 0 ? round4(pos.totalCost / pos.quantity) : 0,
    });
  }
  return lots;
}

function officialCloseOnAsOf(close: OfficialClose | undefined, asOf: string): OfficialClose | undefined {
  if (!close || close.price <= 0 || close.date !== asOf) return undefined;
  return close;
}

function lineFromLot(
  lot: PortfolioLot,
  close: OfficialClose | undefined,
  lineNo: number,
  asOf: string,
): PortfolioStatementLine {
  const priced = officialCloseOnAsOf(close, asOf);
  const marketValue = priced ? round4(lot.quantity * priced.price) : null;
  const unrealizedGross = marketValue != null ? round4(marketValue - lot.totalCost) : null;
  const profitPctGross = unrealizedGross != null && lot.totalCost > 0
    ? roundPct(unrealizedGross / lot.totalCost)
    : null;
  const lineComm = marketValue != null ? expectedSellCommissionOnMv(marketValue) : null;
  const displayedProfitValue =
    marketValue != null && lineComm != null ? round4(marketValue - lineComm - lot.totalCost) : null;
  const displayedProfitPctValue =
    displayedProfitValue != null && lot.totalCost > 0
      ? roundPct(displayedProfitValue / lot.totalCost)
      : null;
  return {
    lineNo,
    companyName: lot.companyName,
    ticker: lot.ticker,
    compId: lot.compId,
    currency: "QAR",
    accountTypePrinted: null,
    quantity: lot.quantity,
    costValue: lot.totalCost,
    shareCost: lot.avgCost,
    closePrice: priced ? priced.price : null,
    closeDate: priced ? priced.date : null,
    priceSource: priced ? "official_close" : "missing_close",
    marketValue,
    unrealizedGross,
    profitPctGross,
    currencyDifference: 0,
    sectorCode: null,
    sectorName: lot.sector,
    breakEven: lot.quantity > 0 ? engineMoney(breakEvenFromAvgCost(lot.avgCost)) : unknownMoney("BREAK_EVEN_RULE"),
    displayedProfit:
      displayedProfitValue == null ? unknownMoney("MISSING_CLOSE") : engineMoney(displayedProfitValue),
    displayedProfitPct:
      displayedProfitPctValue == null ? unknownMoney("MISSING_CLOSE") : engineMoney(displayedProfitPctValue),
  };
}

function groupSectors(lines: PortfolioStatementLine[]): PortfolioStatementSector[] {
  const byName = new Map<string, PortfolioStatementLine[]>();
  for (const line of lines) {
    const list = byName.get(line.sectorName) || [];
    list.push(line);
    byName.set(line.sectorName, list);
  }
  const knownMv = lines.reduce((s, l) => s + (l.marketValue ?? 0), 0);
  const sectors: PortfolioStatementSector[] = [];
  for (const [sectorName, sectorLines] of byName) {
    const marketValue = sectorLines.every((l) => l.marketValue != null)
      ? round4(sectorLines.reduce((s, l) => s + (l.marketValue ?? 0), 0))
      : null;
    const costValue = round4(sectorLines.reduce((s, l) => s + l.costValue, 0));
    const weightPct = marketValue != null && knownMv > 0 ? roundPct(marketValue / knownMv) : null;
    sectors.push({
      sectorCode: null,
      sectorName,
      weightPct,
      marketValue,
      costValue,
      lines: sectorLines.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0)),
    });
  }
  return sectors.sort((a, b) => a.sectorName.localeCompare(b.sectorName));
}

export function assemblePortfolioStatement(input: {
  asOf: string;
  investor: StatementInvestorHeader;
  lots: PortfolioLot[];
  closes: Map<string, OfficialClose>;
  cashLedgerBalance: number;
  realizedToAsOf: number;
  printedAtIso: string;
}): PortfolioStatement {
  const missingCloses: string[] = [];
  const lines = input.lots.map((lot, i) => {
    const close = input.closes.get(lot.ticker);
    if (!officialCloseOnAsOf(close, input.asOf)) missingCloses.push(lot.ticker);
    return lineFromLot(lot, close, i + 1, input.asOf);
  });
  const sectors = groupSectors(lines);
  const grandTotalCost = round4(lines.reduce((s, l) => s + l.costValue, 0));
  const allPriced = lines.length === 0 || lines.every((l) => l.marketValue != null);
  const grandTotalMarketValue = allPriced
    ? round4(lines.reduce((s, l) => s + (l.marketValue ?? 0), 0))
    : null;
  const cash = round4(input.cashLedgerBalance);
  const cashMoney = sqlMoney(cash);
  const expectedSellCommission =
    grandTotalMarketValue == null ? null : expectedSellCommissionOnMv(grandTotalMarketValue);
  const expectedProfitLoss =
    grandTotalMarketValue == null || expectedSellCommission == null
      ? null
      : round4(grandTotalMarketValue - expectedSellCommission - grandTotalCost);
  const netAfterExpectedSellComm =
    grandTotalMarketValue == null || expectedSellCommission == null
      ? null
      : round4(grandTotalMarketValue - expectedSellCommission);
  // س-04: NAV = MV − expected sell commission + client cash
  const netAssetValue =
    netAfterExpectedSellComm == null ? null : round4(netAfterExpectedSellComm + cash);
  // س-03: Dr/Cr and client net cash = cash balance that day
  const netProfitLoss =
    expectedProfitLoss == null ? null : round4(expectedProfitLoss + input.realizedToAsOf);

  return {
    kind: "portfolio",
    titleEn: "Unrealized Profit/Loss Summary",
    titleAr: "ملخص الأرباح والخسائر غير المحققة",
    company: QSC_STATEMENT_COMPANY,
    investor: input.investor,
    dates: { mode: "as_of", asOf: input.asOf },
    closingPricesAsOf: input.asOf,
    sectors,
    grandTotalCost,
    grandTotalMarketValue,
    missingCloses,
    footer: {
      marketValue: grandTotalMarketValue == null ? unknownMoney("MISSING_CLOSE") : engineMoney(grandTotalMarketValue),
      expectedProfitLoss:
        expectedProfitLoss == null ? unknownMoney("MISSING_CLOSE") : engineMoney(expectedProfitLoss),
      expectedSellCommission:
        expectedSellCommission == null
          ? unknownMoney("MISSING_CLOSE")
          : engineMoney(expectedSellCommission),
      netAfterExpectedSellComm:
        netAfterExpectedSellComm == null
          ? unknownMoney("MISSING_CLOSE")
          : engineMoney(netAfterExpectedSellComm),
      currencyDifference: engineMoney(0),
      drCrBalance: cashMoney,
      realizedTradingPl: engineMoney(input.realizedToAsOf),
      receivedProfits: unknownMoney("DIVIDEND_SOURCE"),
      nonReceivedProfits: unknownMoney("DIVIDEND_SOURCE"),
      realizedTotal: engineMoney(input.realizedToAsOf),
      clientNetCashBalance: cashMoney,
      netProfitLoss: netProfitLoss == null ? unknownMoney("MISSING_CLOSE") : engineMoney(netProfitLoss),
      netAssetValue: netAssetValue == null ? unknownMoney("MISSING_CLOSE") : engineMoney(netAssetValue),
      cashLedgerBalance: cashMoney,
    },
    print: { printedAtIso: input.printedAtIso, page: null },
  };
}

export function portfolioStatementFromLedgers(input: {
  asOf: string;
  accountId: number;
  shares: ExtShareRow[];
  cash: ExtCashRow[];
  investor: StatementInvestorHeader;
  sectors: Map<string, string>;
  companyNames: Map<string, string>;
  closes: Map<string, OfficialClose>;
  printedAtIso: string;
}): PortfolioStatement {
  const lots = lotsFromShares(input.shares, input.asOf, input.sectors, input.companyNames);
  const realizedToAsOf = realizedFromEvents(eventsFromShares(input.shares, input.asOf));
  return assemblePortfolioStatement({
    asOf: input.asOf,
    investor: { ...input.investor, accountId: input.investor.accountId || input.accountId },
    lots,
    closes: input.closes,
    cashLedgerBalance: cashBalance(input.cash, input.asOf),
    realizedToAsOf,
    printedAtIso: input.printedAtIso,
  });
}

export { buildInvestorHeader };
