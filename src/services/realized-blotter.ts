import {
  unitPriceFromShare,
  type ExtShareRow,
} from "./ext-sql-portfolio.js";
import {
  QSC_STATEMENT_COMPANY,
  type RealizedBlotterLine,
  type RealizedBlotterSide,
  type RealizedDetailsStatement,
  type RealizedDetailsStock,
  type StatementInvestorHeader,
} from "./statement-types.js";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const FLAT = 0.0001;

type LotState = {
  qty: number;
  cost: number;
  cumulative: number;
};

function avgCost(lot: LotState): number {
  return lot.qty > FLAT ? round4(lot.cost / lot.qty) : 0;
}

function sideOf(row: ExtShareRow): RealizedBlotterSide | null {
  const inv = String(row.invType || "").trim().toUpperCase();
  if (inv === "SP") return "SP";
  const flag = String(row.buySellFlag || "").trim().toUpperCase();
  if (flag === "B") return "Buy";
  if (flag === "S") return "Sell";
  return null;
}

export function replayRealizedBlotter(shares: ExtShareRow[]): Array<RealizedBlotterLine & { ticker: string; companyName: string; compId: number | null }> {
  const sorted = [...shares].sort((a, b) => a.invDate.localeCompare(b.invDate) || a.id - b.id);
  const lots = new Map<string, LotState>();
  const out: Array<RealizedBlotterLine & { ticker: string; companyName: string; compId: number | null }> = [];

  for (const row of sorted) {
    const ticker = row.tickerId.trim();
    if (!ticker || !row.invDate) continue;
    const side = sideOf(row);
    if (!side) continue;
    const lot = lots.get(ticker) || { qty: 0, cost: 0, cumulative: 0 };
    const price = unitPriceFromShare(row);
    const qty = row.qty;
    let buyQty = 0;
    let sellQty = 0;
    let buyValue = 0;
    let sellValue = 0;
    let grossSaleCost = 0;
    let dayResult = 0;
    const shareCostBefore = avgCost(lot);

    if (side === "SP") {
      buyQty = qty;
      lot.qty += qty;
    } else if (side === "Buy") {
      buyQty = qty;
      buyValue = qty * price;
      lot.qty += qty;
      lot.cost += buyValue;
      buyValue = round4(buyValue);
    } else {
      sellQty = qty;
      const sellTake = Math.min(qty, lot.qty);
      const unit = lot.qty > FLAT ? lot.cost / lot.qty : 0;
      grossSaleCost = sellTake * unit;
      sellValue = qty * price;
      dayResult = sellValue - grossSaleCost;
      lot.qty -= sellTake;
      lot.cost -= grossSaleCost;
      if (lot.qty <= FLAT) {
        lot.qty = 0;
        lot.cost = 0;
      }
      lot.cumulative += dayResult;
      sellValue = round4(sellValue);
      grossSaleCost = round4(grossSaleCost);
      dayResult = round4(dayResult);
    }

    lots.set(ticker, lot);
    const displayedAvg = side === "Sell" ? shareCostBefore : avgCost(lot) || shareCostBefore;
    out.push({
      date: row.invDate,
      invNo: row.invNo,
      side,
      buyQty,
      sellQty,
      shareBalance: round4(lot.qty),
      price: round4(price),
      buyValue: round4(buyValue),
      sellValue,
      shareCost: round4(displayedAvg),
      grossSaleCost,
      dayResult,
      profitLossCumulative: round4(lot.cumulative),
      isOpening: false,
      ticker,
      companyName: row.companyName || ticker,
      compId: row.compId,
    });
  }
  return out;
}

export function openingBlotterLine(
  history: Array<RealizedBlotterLine & { ticker: string }>,
  ticker: string,
  from: string,
): RealizedBlotterLine | null {
  const prior = history.filter((row) => row.ticker === ticker && row.date < from);
  if (prior.length === 0) return null;
  const last = prior[prior.length - 1];
  if (last.shareBalance <= FLAT && last.profitLossCumulative === 0) return null;
  return {
    date: last.date,
    invNo: null,
    side: "Balance",
    buyQty: 0,
    sellQty: 0,
    shareBalance: last.shareBalance,
    price: 0,
    buyValue: round4(last.shareBalance * last.shareCost),
    sellValue: 0,
    shareCost: last.shareCost,
    grossSaleCost: 0,
    dayResult: 0,
    profitLossCumulative: last.profitLossCumulative,
    isOpening: true,
  };
}

export function blotterForPeriod(
  shares: ExtShareRow[],
  from: string,
  to: string,
): Array<{ ticker: string; companyName: string; compId: number | null; opening: RealizedBlotterLine | null; lines: RealizedBlotterLine[] }> {
  const history = replayRealizedBlotter(shares);
  const tickers = [...new Set(history.filter((row) => row.date >= from && row.date <= to).map((row) => row.ticker))];
  return tickers.map((ticker) => {
    const sample = history.find((row) => row.ticker === ticker)!;
    const lines = history
      .filter((row) => row.ticker === ticker && row.date >= from && row.date <= to)
      .map(({ ticker: _t, companyName: _c, compId: _id, ...line }) => line);
    return {
      ticker,
      companyName: sample.companyName,
      compId: sample.compId,
      opening: openingBlotterLine(history, ticker, from),
      lines,
    };
  });
}

function stockTotals(opening: RealizedBlotterLine | null, lines: RealizedBlotterLine[]): RealizedDetailsStock["totals"] {
  return {
    buyQty: lines.reduce((s, l) => s + l.buyQty, 0),
    sellQty: lines.reduce((s, l) => s + l.sellQty, 0),
    buyValue: round4(lines.reduce((s, l) => s + l.buyValue, 0)),
    sellValue: round4(lines.reduce((s, l) => s + l.sellValue, 0)),
    dayResult: round4(lines.reduce((s, l) => s + l.dayResult, 0)),
  };
}

export function assembleRealizedDetails(input: {
  from: string;
  to: string;
  investor: StatementInvestorHeader;
  shares: ExtShareRow[];
  printedAtIso: string;
}): RealizedDetailsStatement {
  const groups = blotterForPeriod(input.shares, input.from, input.to);
  const stocks: RealizedDetailsStock[] = groups.map((g) => {
    const lines = g.opening ? [g.opening, ...g.lines] : g.lines;
    return {
      companyName: g.companyName,
      ticker: g.ticker,
      compId: g.compId,
      currency: "QAR",
      lines,
      totals: stockTotals(g.opening, g.lines),
    };
  });
  return {
    kind: "realized_details",
    titleEn: "Transactions Details",
    titleAr: "كشف الأرباح والخسائر المحققة — تفصيلي",
    company: QSC_STATEMENT_COMPANY,
    investor: input.investor,
    dates: { mode: "range", from: input.from, to: input.to },
    stocks,
    print: { printedAtIso: input.printedAtIso, page: null },
  };
}
