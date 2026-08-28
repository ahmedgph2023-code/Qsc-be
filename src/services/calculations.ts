import { db, schema } from "../db/connection.js";
import { eq, and, asc, inArray, lte } from "drizzle-orm";
import { loadAppliedCaDeltas } from "./corporate-action-portfolio.js";
import { sumCashLedgerAsOf } from "./cash-sign.js";
import { isInKindShareMove, isSell } from "../lib/tx-type.js";
import { tryEvaluateFormula } from "../lib/formula-eval.js";
import { getFormulaMap } from "./portfolio-formulas.js";
import { applyReplayEvents, eventsThroughAsOf, currentLotOpenedOn, calendarDaysBetween, lastTxPrice, navAllocation, excelHoldingReturn, excelAnnualizedReturn, excelReturnContribution, excelEquityTotals, type ReplayEvent } from "./holdings-replay.js";
import { applyHoldingFormulas, buildNavDailyPoints, getFirstActivityDate, resolvePortfolioBenchmark } from "./excel-workbook-engine.js";
import { buildEquityValueHistory } from "./equity-value-history.js";

export type { ReplayEvent };
export { applyReplayEvents, eventsThroughAsOf, currentLotOpenedOn, calendarDaysBetween, navAllocation, excelHoldingReturn, excelAnnualizedReturn, excelReturnContribution, excelEquityTotals };

function toNum(v: unknown): number { return Number(v ?? 0); }

function txDate(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}

type PricePoint = { date: string; price: number };

async function loadPriceSeries(stockIds: string[]): Promise<Map<string, PricePoint[]>> {
  const map = new Map<string, PricePoint[]>();
  if (stockIds.length === 0) return map;
  const rows = await db.select({
    stockId: schema.stockPrices.stockId,
    date: schema.stockPrices.date,
    price: schema.stockPrices.price,
  }).from(schema.stockPrices)
    .where(inArray(schema.stockPrices.stockId, stockIds))
    .orderBy(asc(schema.stockPrices.date));
  for (const r of rows) {
    const list = map.get(r.stockId) ?? [];
    if (list.length === 0) map.set(r.stockId, list);
    list.push({ date: r.date, price: toNum(r.price) });
  }
  return map;
}

function latestPriceFromSeries(series: PricePoint[] | undefined, asOf?: string): number {
  if (!series?.length) return 0;
  if (!asOf) return series[series.length - 1].price;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].date <= asOf) return series[i].price;
  }
  return 0;
}

async function buildPortfolioReplayEvents(portfolioId: string, asOf?: string): Promise<ReplayEvent[]> {
  const txs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp));
  const apps = await loadAppliedCaDeltas(portfolioId);

  const events: ReplayEvent[] = [];
  for (const tx of txs) {
    const date = txDate(tx.timestamp);
    events.push({
      kind: "tx",
      date,
      sort: 0,
      stockId: tx.stockId,
      type: tx.type,
      quantity: toNum(tx.quantity),
      price: toNum(tx.price),
      cashless: isInKindShareMove(tx.type, tx.notes),
    });
  }
  for (const app of apps) {
    const date = String(app.actionDate).slice(0, 10);
    events.push({
      kind: "ca",
      date,
      sort: 1,
      stockId: app.stockId,
      qtyDelta: toNum(app.qtyDelta),
      costDelta: toNum(app.costAfter) - toNum(app.costBefore),
    });
  }
  const clipped = eventsThroughAsOf(events, asOf);
  clipped.sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);
  return clipped;
}

export async function getCashBalanceAsOf(portfolioId: string, asOf: string): Promise<number> {
  const rows = await db.select().from(schema.cashTransactions)
    .where(and(
      eq(schema.cashTransactions.portfolioId, portfolioId),
      lte(schema.cashTransactions.tradeDate, asOf),
    ));
  return sumCashLedgerAsOf(rows, asOf);
}

export interface Holding {
  stockId: string; ticker: string; companyName: string; sector: string;
  quantity: number; totalCost: number; avgCost: number;
  currentPrice: number; currentValue: number; gainLossValue: number; gainLossPct: number;
  openedOn: string | null; holdingDays: number | null;
  excelAnnualizedPct: number | null; excelContributionPct: number | null;
  excelWeight: number | null;
}

export async function getPortfolioHoldings(portfolioId: string, asOf?: string, replayEvents?: ReplayEvent[]): Promise<Holding[]> {
  const events = replayEvents ?? await buildPortfolioReplayEvents(portfolioId, asOf);
  const agg = applyReplayEvents(events);
  const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);

  const stockIds = [...agg.entries()].filter(([, a]) => a.quantity > 0.0001).map(([id]) => id);
  const [formulas, stockRows, priceMap] = await Promise.all([
    getFormulaMap(),
    stockIds.length
      ? db.select().from(schema.stocks).where(inArray(schema.stocks.id, stockIds))
      : Promise.resolve([] as typeof schema.stocks.$inferSelect[]),
    loadPriceSeries(stockIds),
  ]);
  const stockById = new Map(stockRows.map((s) => [s.id, s]));

  const holdings: Holding[] = [];
  for (const stockId of stockIds) {
    const a = agg.get(stockId);
    if (!a) continue;
    const stock = stockById.get(stockId);
    if (!stock) continue;
    let currentPrice = latestPriceFromSeries(priceMap.get(stockId), asOf);
    if (!currentPrice) currentPrice = lastTxPrice(events, stockId);
    const openedOn = currentLotOpenedOn(events, stockId);
    const valued = applyHoldingFormulas({
      quantity: a.quantity,
      avgCost: a.quantity > 0 ? a.totalCost / a.quantity : 0,
      currentPrice,
      totalCost: a.totalCost,
    }, formulas);
    holdings.push({
      stockId, ticker: stock.ticker, companyName: stock.companyName, sector: stock.sector,
      quantity: Math.round(a.quantity * 10000) / 10000,
      totalCost: valued.totalCost,
      avgCost: a.quantity > 0 ? Math.round((a.totalCost / a.quantity) * 10000) / 10000 : 0,
      currentPrice: Math.round(currentPrice * 10000) / 10000,
      currentValue: valued.currentValue,
      gainLossValue: valued.gainLossValue,
      gainLossPct: valued.totalCost > 0 ? Math.round((valued.gainLossValue / valued.totalCost) * 1_000_000) / 10_000 : 0,
      openedOn,
      holdingDays: openedOn != null ? calendarDaysBetween(openedOn, asOfDate) : null,
      excelAnnualizedPct: null,
      excelContributionPct: null,
      excelWeight: null,
    });
  }
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
  const asOfCash = asOf
    ? await getCashBalanceAsOf(portfolioId, asOf)
    : await (async () => {
      const [p] = await db.select({ cashBalance: schema.portfolios.cashBalance })
        .from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
      return toNum(p?.cashBalance);
    })();
  const totalEquity = holdings.reduce((s, h) => s + h.currentValue, 0) + asOfCash;
  for (const h of holdings) {
    const wDefault = totalEquity > 0 ? h.currentValue / totalEquity : 0;
    const w = formulas.weight
      ? tryEvaluateFormula(formulas.weight, { equity: h.currentValue, totalEquity }, wDefault)
      : wDefault;
    h.excelWeight = w == null ? null : Math.round(w * 1_000_000) / 1_000_000;
  }
  return holdings;
}

export async function getPortfolioMetrics(portfolioId: string, asOf?: string) {
  const events = await buildPortfolioReplayEvents(portfolioId, asOf);
  const holdings = await getPortfolioHoldings(portfolioId, asOf, events);

  let netCashInvested = 0;
  let realizedPnL = 0;
  const costBasis = new Map<string, { quantity: number; totalCost: number }>();

  for (const ev of events) {
    const prev = costBasis.get(ev.stockId) || { quantity: 0, totalCost: 0 };
    if (ev.kind === "tx") {
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
    } else {
      costBasis.set(ev.stockId, {
        quantity: prev.quantity + ev.qtyDelta,
        totalCost: Math.max(0, prev.totalCost + ev.costDelta),
      });
    }
  }

  const currentValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const unrealizedPnL = holdings.reduce((s, h) => s + h.gainLossValue, 0);
  const returnPct = netCashInvested > 0 ? ((currentValue - netCashInvested) / netCashInvested) * 100 : 0;

  const asOfCash = asOf
    ? await getCashBalanceAsOf(portfolioId, asOf)
    : await (async () => {
      const [p] = await db.select({ cashBalance: schema.portfolios.cashBalance })
        .from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
      return toNum(p?.cashBalance);
    })();
  const navValue = Math.round((currentValue + asOfCash) * 10000) / 10000;
  const navReturnPct = netCashInvested > 0 ? ((navValue - netCashInvested) / netCashInvested) * 100 : 0;

  const formulas = await getFormulaMap();
  const cashCostDefault = asOfCash;
  const cashCost = formulas.cash_total_cost
    ? tryEvaluateFormula(formulas.cash_total_cost, { cash: asOfCash }, cashCostDefault) ?? cashCostDefault
    : cashCostDefault;
  const excelDefault = excelEquityTotals(holdings, asOfCash);
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
  const excelWorkbook = {
    equityValue: excelDefault.equityValue,
    totalCost: totalCostInclCash,
    gain: gain == null ? excelDefault.gain : Math.round(gain * 10000) / 10000,
    growth,
    growthPct: growth == null ? null : Math.round(growth * 1_000_000) / 10_000,
  };
  return {
    totalInvested: Math.round(netCashInvested * 10000) / 10000,
    currentValue: Math.round(currentValue * 10000) / 10000,
    /** Equity MV only vs trade-invested cash (legacy; BD-004 may supersede). */
    returnPct: Math.round(returnPct * 10000) / 10000,
    /** Equity MV + cash ledger (AUD-H01 additive; preferred NAV simple return until BD-004). */
    cashBalance: Math.round(asOfCash * 10000) / 10000,
    navValue,
    navReturnPct: Math.round(navReturnPct * 10000) / 10000,
    unrealizedPnL: Math.round(unrealizedPnL * 10000) / 10000,
    realizedPnL: Math.round(realizedPnL * 10000) / 10000,
    holdings,
    allocation: navAllocation(holdings, asOfCash),
    excelWorkbook,
  };
}

export async function calculateTWAR(portfolioId: string, asOf?: string): Promise<{ twar: number; subPeriods: any[] }> {
  const allTxs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp));
  const txs = asOf ? allTxs.filter((t) => txDate(t.timestamp) <= asOf) : allTxs;
  if (txs.length === 0) return { twar: 0, subPeriods: [] };

  const stockIds = [...new Set(txs.map((t) => t.stockId))];
  const stockMap = await loadPriceSeries(stockIds);

  function getLatestPriceDate(): string {
    let latest = "1900-01-01";
    for (const prices of stockMap.values()) {
      if (prices.length === 0) continue;
      const lastDate = prices[prices.length - 1].date;
      if (lastDate > latest) latest = lastDate;
    }
    return latest;
  }

  function getPortfolioValue(holdings: Map<string, number>, date: string) {
    let total = 0;
    for (const [stockId, qty] of holdings) {
      if (qty <= 0) continue;
      const prices = stockMap.get(stockId);
      if (!prices) continue;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].date <= date) { total += qty * prices[i].price; break; }
      }
    }
    return total;
  }

  const holdings = new Map<string, number>();
  const subPeriods: any[] = [];
  let twar = 1;
  let periodStartValue = 0;
  let periodStartDate = "";
  let isFirstCashFlow = true;

  for (const tx of txs) {
    const txDate = tx.timestamp.toISOString().split("T")[0];
    const txQty = toNum(tx.quantity);
    const txPrice = toNum(tx.price);

    if (isFirstCashFlow) {
      // FIX: Apply the first transaction, then capture the portfolio value AFTER it as the
      // sub-period start. The old code used getPortfolioValue BEFORE the transaction (which
      // returns 0 for an empty portfolio), causing the first sub-period's start value to be
      // set from the buy-day price rather than the actual post-transaction value. This
      // misplaced the boundary and lost the price appreciation on day 1 of the first holding.
      const currQty = holdings.get(tx.stockId) || 0;
      if (!isSell(tx.type)) holdings.set(tx.stockId, currQty + txQty);
      else holdings.set(tx.stockId, Math.max(0, currQty - txQty));

      periodStartValue = getPortfolioValue(holdings, txDate);
      periodStartDate = txDate;
      isFirstCashFlow = false;
      continue;
    }

    // Value of portfolio just BEFORE this transaction (no cash flow applied yet)
    const endValue = getPortfolioValue(holdings, txDate);

    const subReturn = periodStartValue > 0 ? (endValue - periodStartValue) / periodStartValue : 0;
    twar *= (1 + subReturn);

    subPeriods.push({
      startDate: periodStartDate,
      endDate: txDate,
      startValue: Math.round(periodStartValue * 10000) / 10000,
      endValue: Math.round(endValue * 10000) / 10000,
      returnPct: Math.round(subReturn * 1000000) / 10000,
      event: `${tx.type} ${txQty} @ ${txPrice}`,
    });

    // Apply this transaction to open the next sub-period
    const currQty = holdings.get(tx.stockId) || 0;
    if (!isSell(tx.type)) holdings.set(tx.stockId, currQty + txQty);
    else holdings.set(tx.stockId, Math.max(0, currQty - txQty));

    // Value just AFTER transaction = start of next sub-period
    periodStartValue = getPortfolioValue(holdings, txDate);
    periodStartDate = txDate;
  }

  // Final sub-period: from last transaction to latest price date (or as-of)
  if (!isFirstCashFlow) {
    const latest = getLatestPriceDate();
    const valuationDate = asOf && asOf < latest ? asOf : latest;
    const finalValue = getPortfolioValue(holdings, valuationDate);
    if (periodStartValue > 0) {
      const finalReturn = (finalValue - periodStartValue) / periodStartValue;
      twar *= (1 + finalReturn);
      subPeriods.push({
        startDate: periodStartDate,
        endDate: valuationDate,
        startValue: Math.round(periodStartValue * 10000) / 10000,
        endValue: Math.round(finalValue * 10000) / 10000,
        returnPct: Math.round(finalReturn * 1000000) / 10000,
        event: "Current",
      });
    }
  }

  return { twar: Math.round((twar - 1) * 1000000) / 10000, subPeriods };
}

export async function getMonthlySimpleReturns(portfolioId: string, asOf?: string): Promise<{ year: number; month: number; netCashInvested: number; monthEndValue: number; simpleReturnPct: number }[]> {
  const allTxs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp));
  const txs = asOf ? allTxs.filter((t) => txDate(t.timestamp) <= asOf) : allTxs;
  if (txs.length === 0) return [];

  const stockIds = [...new Set(txs.map((t) => t.stockId))];
  const stockMap = await loadPriceSeries(stockIds);
  let maxPriceDate = "";
  for (const prices of stockMap.values()) {
    if (prices.length > 0 && prices[prices.length - 1].date > maxPriceDate) {
      maxPriceDate = prices[prices.length - 1].date;
    }
  }

  const holdings = new Map<string, number>();
  let netCashInvested = 0;

  const firstIso = txDate(txs[0].timestamp);
  const lastIso = txDate(txs[txs.length - 1].timestamp);
  let dataEndStr = maxPriceDate > lastIso ? maxPriceDate : lastIso;
  if (asOf && asOf < dataEndStr) dataEndStr = asOf;

  let currentYear = Number(firstIso.slice(0, 4));
  let currentMonth = Number(firstIso.slice(5, 7));
  const endYear = Number(dataEndStr.slice(0, 4));
  const endMonth = Number(dataEndStr.slice(5, 7));

  const results: { year: number; month: number; netCashInvested: number; monthEndValue: number; simpleReturnPct: number }[] = [];

  while (currentYear < endYear || (currentYear === endYear && currentMonth <= endMonth)) {
    let monthEndStr = new Date(Date.UTC(currentYear, currentMonth, 0)).toISOString().split("T")[0];
    if (asOf && monthEndStr > asOf) monthEndStr = asOf;

    for (const tx of txs) {
      const d = txDate(tx.timestamp);
      if (Number(d.slice(0, 4)) === currentYear && Number(d.slice(5, 7)) === currentMonth) {
        const qty = toNum(tx.quantity);
        const price = toNum(tx.price);
        const amount = qty * price;
        if (!isSell(tx.type)) netCashInvested += amount;
        else netCashInvested -= amount;
        const currQty = holdings.get(tx.stockId) || 0;
        if (!isSell(tx.type)) holdings.set(tx.stockId, currQty + qty);
        else holdings.set(tx.stockId, Math.max(0, currQty - qty));
      }
    }

    let monthEndValue = 0;
    for (const [stockId, qty] of holdings) {
      if (qty <= 0.0001) continue;
      const prices = stockMap.get(stockId);
      if (!prices) continue;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].date <= monthEndStr) { monthEndValue += qty * prices[i].price; break; }
      }
    }

    const simpleReturnPct = netCashInvested > 0 ? ((monthEndValue - netCashInvested) / netCashInvested) * 100 : 0;

    results.push({
      year: currentYear, month: currentMonth,
      netCashInvested: Math.round(netCashInvested * 10000) / 10000,
      monthEndValue: Math.round(monthEndValue * 10000) / 10000,
      simpleReturnPct: Math.round(simpleReturnPct * 10000) / 10000,
    });

    currentMonth++;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  }

  // Add a "current" point for the valuation date when it is mid-month
  const today = asOf || new Date().toISOString().split("T")[0];
  const lastResult = results.length > 0 ? results[results.length - 1] : null;
  const asOfDate = new Date(today + "T12:00:00Z");
  if (lastResult && lastResult.year !== asOfDate.getUTCFullYear() || (lastResult && lastResult.month !== asOfDate.getUTCMonth() + 1)) {
    let todayValue = 0;
    for (const [stockId, qty] of holdings) {
      if (qty <= 0.0001) continue;
      const prices = stockMap.get(stockId);
      if (!prices) continue;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].date <= today) { todayValue += qty * prices[i].price; break; }
      }
    }
    const todayReturnPct = netCashInvested > 0 ? ((todayValue - netCashInvested) / netCashInvested) * 100 : 0;
    results.push({
      year: asOfDate.getUTCFullYear(),
      month: asOfDate.getUTCMonth() + 1,
      netCashInvested: Math.round(netCashInvested * 10000) / 10000,
      monthEndValue: Math.round(todayValue * 10000) / 10000,
      simpleReturnPct: Math.round(todayReturnPct * 10000) / 10000,
    });
  }

  return results;
}

export async function getPortfolioValueHistory(portfolioId: string, asOf?: string): Promise<{ date: string; value: number }[]> {
  const allTxs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp));
  const txs = asOf ? allTxs.filter((t) => txDate(t.timestamp) <= asOf) : allTxs;
  if (txs.length === 0) return [];

  const stockIds = [...new Set(txs.map((t) => t.stockId))];
  const stockMap = await loadPriceSeries(stockIds);
  return buildEquityValueHistory(txs, stockMap, asOf);
}

export type { NavDailyPoint } from "./excel-workbook-engine.js";

export async function getNavDailyChanges(
  portfolioId: string,
  asOf?: string,
  limit = 120,
  equityHist?: { date: string; value: number }[],
) {
  const hist = equityHist ?? await getPortfolioValueHistory(portfolioId, asOf);
  if (hist.length === 0) return [];
  const cashRows = await db.select().from(schema.cashTransactions)
    .where(eq(schema.cashTransactions.portfolioId, portfolioId));
  const formulas = await getFormulaMap();
  return buildNavDailyPoints(hist, (date) => sumCashLedgerAsOf(cashRows, date), formulas, limit);
}

export async function getPerformanceVsIndex(
  portfolioId: string,
  asOf?: string,
  portHistory?: { date: string; value: number }[],
): Promise<any> {
  const bench = await resolvePortfolioBenchmark(portfolioId);
  if (!bench) return null;

  const hist = portHistory ?? await getPortfolioValueHistory(portfolioId, asOf);
  const idxData = await db.select().from(schema.indexDataPoints)
    .where(eq(schema.indexDataPoints.indexId, bench.indexId)).orderBy(asc(schema.indexDataPoints.date));

  if (hist.length === 0 || idxData.length === 0) return null;

  const startDate = (await getFirstActivityDate(portfolioId)) || hist[0].date;

  const basePort = hist[0].value || 1;
  let baseIdx = 0;
  for (const d of idxData) {
    if (d.date <= startDate) baseIdx = toNum(d.value);
    else break;
  }
  const idxFiltered = idxData.filter((d) => d.date >= startDate && (!asOf || d.date <= asOf));
  if (!(baseIdx > 0) && idxFiltered[0]) baseIdx = toNum(idxFiltered[0].value);
  if (!(baseIdx > 0)) return null;

  return {
    indexName: bench.indexName,
    startDate,
    portfolioSeries: hist.map((p) => ({
      date: p.date, value: p.value,
      normalized: basePort > 0 ? Math.round((p.value / basePort) * 1000000) / 10000 : 0,
    })),
    indexSeries: idxFiltered.map((d) => ({
      date: d.date, value: Math.round(toNum(d.value) * 10000) / 10000,
      normalized: Math.round((toNum(d.value) / baseIdx) * 1000000) / 10000,
    })),
  };
}

export async function getMonthlyIndexReturns(indexId: string, startYear: number, startMonth: number): Promise<{ year: number; month: number; returnPct: number }[]> {
  const data = await db.select()
    .from(schema.indexDataPoints)
    .where(eq(schema.indexDataPoints.indexId, indexId))
    .orderBy(asc(schema.indexDataPoints.date));

  if (data.length === 0) return [];

  const results: { year: number; month: number; returnPct: number }[] = [];
  const byMonth = new Map<string, number[]>();

  for (const d of data) {
    const [y, m] = d.date.split("-");
    const key = `${y}-${m}`;
    const vals = byMonth.get(key) || [];
    vals.push(toNum(d.value));
    byMonth.set(key, vals);
  }

  const sortedKeys = [...byMonth.keys()].sort();
  for (let i = 1; i < sortedKeys.length; i++) {
    const prevKey = sortedKeys[i - 1];
    const currKey = sortedKeys[i];
    const prevVals = byMonth.get(prevKey)!;
    const currVals = byMonth.get(currKey)!;
    const prevClose = prevVals[prevVals.length - 1];
    const currClose = currVals[currVals.length - 1];
    const [year, month] = currKey.split("-").map(Number);
    if (Number(`${year}${String(month).padStart(2, "0")}`) >= Number(`${startYear}${String(startMonth).padStart(2, "0")}`)) {
      const ret = prevClose > 0 ? ((currClose - prevClose) / prevClose) * 100 : 0;
      results.push({ year, month, returnPct: Math.round(ret * 10000) / 10000 });
    }
  }

  return results;
}

export async function getAumVsIndex(indexName: string): Promise<{
  portfolioSeries: { date: string; value: number; normalized: number }[];
  indexSeries: { date: string; value: number; normalized: number }[];
} | null> {
  const idx = await db.select().from(schema.indices).where(eq(schema.indices.name, indexName)).limit(1);
  if (idx.length === 0) return null;

  const indexId = idx[0].id;
  const indexData = await db.select().from(schema.indexDataPoints)
    .where(eq(schema.indexDataPoints.indexId, indexId))
    .orderBy(asc(schema.indexDataPoints.date));
  if (indexData.length === 0) return null;

  const allPortfolios = await db.select().from(schema.portfolios);
  const allDates = new Set<string>();
  const portfolioHistories = new Map<string, { date: string; value: number }[]>();

  for (const p of allPortfolios) {
    const h = await getPortfolioValueHistory(p.id);
    portfolioHistories.set(p.id, h);
    for (const d of h) allDates.add(d.date);
  }

  for (const d of indexData) allDates.add(d.date);
  const sortedDates = [...allDates].sort();

  const indexValues = new Map<string, number>();
  for (const d of indexData) {
    indexValues.set(d.date, toNum(d.value));
  }

  const resultPortfolio: { date: string; value: number }[] = [];
  const resultIndex: { date: string; value: number }[] = [];

  for (const date of sortedDates) {
    let totalAum = 0;
    for (const [, history] of portfolioHistories) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date <= date) { totalAum += history[i].value; break; }
      }
    }

    let idxVal = 0;
    let found = false;
    for (let i = indexData.length - 1; i >= 0; i--) {
      if (indexData[i].date <= date) { idxVal = toNum(indexData[i].value); found = true; break; }
    }

    if (totalAum > 0 && found) {
      resultPortfolio.push({ date, value: Math.round(totalAum * 10000) / 10000 });
      resultIndex.push({ date, value: Math.round(idxVal * 10000) / 10000 });
    }
  }

  const baseAum = resultPortfolio.length > 0 ? resultPortfolio[0].value : 1;
  const baseIdx = resultIndex.length > 0 ? resultIndex[0].value : 1;

  return {
    portfolioSeries: resultPortfolio.map((p) => ({
      ...p,
      normalized: baseAum > 0 ? Math.round((p.value / baseAum) * 1000000) / 10000 : 0,
    })),
    indexSeries: resultIndex.map((i) => ({
      ...i,
      normalized: baseIdx > 0 ? Math.round((i.value / baseIdx) * 1000000) / 10000 : 0,
    })),
  };
}

export async function getDashboardMetrics() {
  const allPortfolios = await db.select().from(schema.portfolios);
  let totalAum = 0;
  for (const p of allPortfolios) {
    const holdings = await getPortfolioHoldings(p.id);
    totalAum += holdings.reduce((s, h) => s + h.currentValue, 0);
  }
  const allCustomers = await db.select().from(schema.customers);
  return {
    totalAum: Math.round(totalAum * 10000) / 10000,
    activeClients: allCustomers.length,
    avgPortfolioSize: allPortfolios.length > 0 ? Math.round((totalAum / allPortfolios.length) * 10000) / 10000 : 0,
    dailyPnL: 0,
    dailyPnLPct: 0,
  };
}

export async function getAumTrajectory(): Promise<{ date: string; value: number }[]> {
  const allPortfolios = await db.select().from(schema.portfolios);
  const allDates = new Set<string>();
  const histories = new Map<string, { date: string; value: number }[]>();

  for (const p of allPortfolios) {
    const h = await getPortfolioValueHistory(p.id);
    histories.set(p.id, h);
    for (const d of h) allDates.add(d.date);
  }

  const sorted = [...allDates].sort().slice(-30);
  return sorted.map((date) => {
    let total = 0;
    for (const [, history] of histories) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date <= date) { total += history[i].value; break; }
      }
    }
    return { date, value: Math.round(total * 10000) / 10000 };
  });
}