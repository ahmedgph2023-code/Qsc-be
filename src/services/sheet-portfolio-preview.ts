import { db, schema } from "../db/connection.js";
import { and, desc, eq, lte } from "drizzle-orm";
import { sumCashLedgerAsOf } from "./cash-sign.js";
import { tryEvaluateFormula } from "../lib/formula-eval.js";
import { getFormulaMap } from "./portfolio-formulas.js";
import {
  applyReplayEvents,
  calendarDaysBetween,
  currentLotOpenedOn,
  excelAnnualizedReturn,
  excelEquityTotals,
  excelHoldingReturn,
  excelReturnContribution,
  eventsThroughAsOf,
  navAllocation,
  type ReplayEvent,
} from "./holdings-replay.js";
import { applyHoldingFormulas } from "./excel-workbook-engine.js";
import { isInKindShareMove, isSell } from "../lib/tx-type.js";
import {
  inspectWorkbook,
  parseCashMatrix,
  parseTrades,
  readWorkbook,
  type ParsedCash,
  type ParsedTrade,
} from "./historical-sheet.js";
import type { Holding } from "./calculations.js";

function toNum(v: unknown): number {
  return Number(v ?? 0);
}

export function tradesToReplayEvents(trades: ParsedTrade[], idByTicker: Map<string, string>): ReplayEvent[] {
  return trades.map((row) => {
    const ticker = row.ticker.toUpperCase();
    return {
      kind: "tx" as const,
      date: row.date,
      sort: 0,
      stockId: idByTicker.get(ticker) || `preview:${ticker}`,
      type: row.type,
      quantity: row.qty,
      price: row.price,
      cashless: isInKindShareMove(row.type, row.notes),
    };
  });
}

export function previewCashBalance(rows: ParsedCash[], asOf: string): number {
  return sumCashLedgerAsOf(
    rows.map((row) => ({ type: row.type, amount: row.amount, tradeDate: row.tradeDate })),
    asOf,
  );
}

function lastTradePrice(trades: ParsedTrade[], ticker: string): number {
  const rows = trades.filter((t) => t.ticker.toUpperCase() === ticker).sort((a, b) => a.date.localeCompare(b.date));
  return rows.length ? rows[rows.length - 1].price : 0;
}

async function priceOnOrBefore(stockId: string, asOf: string): Promise<number> {
  if (stockId.startsWith("preview:")) return 0;
  const rows = await db.select({ price: schema.stockPrices.price })
    .from(schema.stockPrices)
    .where(and(eq(schema.stockPrices.stockId, stockId), lte(schema.stockPrices.date, asOf)))
    .orderBy(desc(schema.stockPrices.date))
    .limit(1);
  return rows.length > 0 ? toNum(rows[0].price) : 0;
}

export async function previewPortfolioFromWorkbooks(opts: {
  tradesPath: string;
  tradesName: string;
  cashPath: string;
  cashName: string;
  asOf?: string;
  clientName?: string;
  clientCode?: string;
}) {
  const asOf = opts.asOf || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Qatar" });
  const tradesWb = readWorkbook(opts.tradesPath);
  const cashWb = readWorkbook(opts.cashPath);
  const tradesInspect = inspectWorkbook(tradesWb, opts.tradesName, "trades");
  const cashInspect = inspectWorkbook(cashWb, opts.cashName, "cash");
  const trades = parseTrades(tradesInspect.objects);
  const cash = parseCashMatrix(cashInspect.matrix);
  const tickers = [...new Set(trades.rows.map((r) => r.ticker.toUpperCase()))];
  const stocks = tickers.length
    ? await db.select().from(schema.stocks)
    : [];
  const stockByTicker = new Map(stocks.map((s) => [s.ticker.toUpperCase(), s]));
  const idByTicker = new Map<string, string>();
  const tickerById = new Map<string, string>();
  for (const ticker of tickers) {
    const stock = stockByTicker.get(ticker);
    const id = stock?.id || `preview:${ticker}`;
    idByTicker.set(ticker, id);
    tickerById.set(id, ticker);
  }

  const events = eventsThroughAsOf(tradesToReplayEvents(trades.rows, idByTicker), asOf);
  events.sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);
  const agg = applyReplayEvents(events);
  const formulas = await getFormulaMap();
  const holdings: Holding[] = [];

  for (const [stockId, a] of agg) {
    if (a.quantity <= 0.0001) continue;
    const ticker = tickerById.get(stockId) || "";
    const stock = stockByTicker.get(ticker) || { ticker, companyName: ticker, sector: "Equities" };
    const resolvedTicker = (stock.ticker || ticker).toUpperCase();
    const currentPrice = (await priceOnOrBefore(stockId, asOf)) || lastTradePrice(trades.rows, resolvedTicker);
    const openedOn = currentLotOpenedOn(events, stockId);
    const valued = applyHoldingFormulas({
      quantity: a.quantity,
      avgCost: a.quantity > 0 ? a.totalCost / a.quantity : 0,
      currentPrice,
      totalCost: a.totalCost,
    }, formulas);
    holdings.push({
      stockId,
      ticker: resolvedTicker,
      companyName: stock.companyName || resolvedTicker,
      sector: stock.sector || "Equities",
      quantity: Math.round(a.quantity * 10000) / 10000,
      totalCost: valued.totalCost,
      avgCost: a.quantity > 0 ? Math.round((a.totalCost / a.quantity) * 10000) / 10000 : 0,
      currentPrice: Math.round(currentPrice * 10000) / 10000,
      currentValue: valued.currentValue,
      gainLossValue: valued.gainLossValue,
      gainLossPct: valued.totalCost > 0 ? Math.round((valued.gainLossValue / valued.totalCost) * 1_000_000) / 10_000 : 0,
      openedOn,
      holdingDays: openedOn != null ? calendarDaysBetween(openedOn, asOf) : null,
      excelAnnualizedPct: null,
      excelContributionPct: null,
      excelWeight: null,
    });
  }

  const cashBal = previewCashBalance(cash.rows, asOf);
  const totalUnrealized = holdings.reduce((s, h) => s + h.gainLossValue, 0);
  for (const h of holdings) {
    const rDefault = excelHoldingReturn(h.currentValue, h.totalCost);
    const r = formulas.holding_return
      ? tryEvaluateFormula(formulas.holding_return, { equity: h.currentValue, totalCost: h.totalCost }, rDefault)
      : rDefault;
    const annDefault = r != null && h.holdingDays != null ? excelAnnualizedReturn(r, h.holdingDays) : null;
    const ann = formulas.annualized_return && r != null && h.holdingDays != null
      ? tryEvaluateFormula(formulas.annualized_return, { return: r, holdingDays: h.holdingDays }, annDefault)
      : annDefault;
    const contribDefault = excelReturnContribution(h.gainLossValue, totalUnrealized);
    const contrib = formulas.return_contribution
      ? tryEvaluateFormula(formulas.return_contribution, { rowPnL: h.gainLossValue, totalPnL: totalUnrealized }, contribDefault)
      : contribDefault;
    h.excelAnnualizedPct = ann == null ? null : Math.round(ann * 1_000_000) / 10_000;
    h.excelContributionPct = contrib == null ? null : Math.round(contrib * 1_000_000) / 10_000;
  }

  let netCashInvested = 0;
  let realizedPnL = 0;
  const costBasis = new Map<string, { quantity: number; totalCost: number }>();
  for (const ev of events) {
    if (ev.kind !== "tx") continue;
    const prev = costBasis.get(ev.stockId) || { quantity: 0, totalCost: 0 };
    const amount = ev.quantity * ev.price;
    if (ev.cashless || ev.type === "CLIENT_TRANSFER") {
      if (!isSell(ev.type)) {
        costBasis.set(ev.stockId, { quantity: prev.quantity + ev.quantity, totalCost: prev.totalCost + amount });
      } else {
        const sellQty = Math.min(ev.quantity, prev.quantity);
        const avgCost = prev.quantity > 0 ? prev.totalCost / prev.quantity : 0;
        costBasis.set(ev.stockId, { quantity: prev.quantity - sellQty, totalCost: prev.totalCost - sellQty * avgCost });
      }
    } else if (!isSell(ev.type)) {
      netCashInvested += amount;
      costBasis.set(ev.stockId, { quantity: prev.quantity + ev.quantity, totalCost: prev.totalCost + amount });
    } else {
      netCashInvested -= amount;
      const sellQty = Math.min(ev.quantity, prev.quantity);
      const avgCost = prev.quantity > 0 ? prev.totalCost / prev.quantity : 0;
      realizedPnL += sellQty * (ev.price - avgCost);
      costBasis.set(ev.stockId, { quantity: prev.quantity - sellQty, totalCost: prev.totalCost - sellQty * avgCost });
    }
  }

  const equityMv = holdings.reduce((s, h) => s + h.currentValue, 0);
  const cashCostDefault = cashBal;
  const cashCost = formulas.cash_total_cost
    ? tryEvaluateFormula(formulas.cash_total_cost, { cash: cashBal }, cashCostDefault) ?? cashCostDefault
    : cashCostDefault;
  const excelDefault = excelEquityTotals(holdings, cashBal);
  const totalEquity = excelDefault.equityValue;
  const totalCostInclCash = Math.round((holdings.reduce((s, h) => s + h.totalCost, 0) + cashCost) * 10000) / 10000;
  for (const h of holdings) {
    const wDefault = totalEquity > 0 ? h.currentValue / totalEquity : 0;
    const w = formulas.weight
      ? tryEvaluateFormula(formulas.weight, { equity: h.currentValue, totalEquity }, wDefault)
      : wDefault;
    h.excelWeight = w == null ? null : Math.round(w * 1_000_000) / 1_000_000;
  }
  const growth = formulas.portfolio_growth
    ? tryEvaluateFormula(formulas.portfolio_growth, { totalEquity, totalCost: totalCostInclCash }, excelDefault.growth)
    : (totalCostInclCash > 0 ? totalEquity / totalCostInclCash - 1 : excelDefault.growth);
  const gain = formulas.portfolio_gain
    ? tryEvaluateFormula(formulas.portfolio_gain, { totalEquity, totalCost: totalCostInclCash }, totalEquity - totalCostInclCash)
    : totalEquity - totalCostInclCash;
  const nav = Math.round((equityMv + cashBal) * 10000) / 10000;
  const allocation = navAllocation(holdings, cashBal);

  return {
    clientName: opts.clientName || "",
    clientCode: opts.clientCode || "",
    asOf,
    portfolioId: "",
    holdings,
    cashBal,
    equityMv: Math.round(equityMv * 10000) / 10000,
    nav,
    totalInvested: Math.round(netCashInvested * 10000) / 10000,
    unrealizedPnL: Math.round(totalUnrealized * 10000) / 10000,
    realizedPnL: Math.round(realizedPnL * 10000) / 10000,
    twar: 0,
    allocation,
    excelWorkbook: {
      equityValue: excelDefault.equityValue,
      totalCost: totalCostInclCash,
      gain: gain == null ? excelDefault.gain : Math.round(gain * 10000) / 10000,
      growth,
      growthPct: growth == null ? null : Math.round(growth * 1_000_000) / 10_000,
      indexPerformancePct: null,
      indexName: null,
      indexFromDate: null,
      indexToDate: null,
    },
    dailyChanges: [] as Array<{ date: string; nav: number; chgQar: number | null; chgPct: number | null }>,
    valueHistory: [] as Array<{ date: string; value: number }>,
    parsed: { trades: trades.rows.length, cash: cash.rows.length, skippedTrades: trades.skipped, skippedCash: cash.skipped },
  };
}
