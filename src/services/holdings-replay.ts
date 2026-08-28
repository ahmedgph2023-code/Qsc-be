import { isSell } from "../lib/tx-type.js";

export type ReplayEvent =
  | { kind: "tx"; date: string; sort: number; stockId: string; type: "BUY" | "SELL" | "CLIENT_TRANSFER"; quantity: number; price: number; cashless?: boolean }
  | { kind: "ca"; date: string; sort: number; stockId: string; qtyDelta: number; costDelta: number };

/** Keep events with `date <= asOf`. Same predicate as `buildPortfolioReplayEvents` (`date > asOf` skip). */
export function eventsThroughAsOf(events: ReplayEvent[], asOf?: string): ReplayEvent[] {
  if (!asOf) return events;
  return events.filter((ev) => ev.date <= asOf);
}

const FLAT = 0.0001;

function qtyAfter(prevQty: number, ev: ReplayEvent): number {
  if (ev.kind === "tx") {
    if (!isSell(ev.type)) return prevQty + ev.quantity;
    return prevQty - Math.min(ev.quantity, prevQty);
  }
  return prevQty + ev.qtyDelta;
}

/**
 * Start date of the **current** open lot (requirements §21).
 * Full close (qty → 0) clears the date; the next buy/transfer/CA that reopens sets a new one.
 */
export function currentLotOpenedOn(events: ReplayEvent[], stockId: string): string | null {
  let qty = 0;
  let opened: string | null = null;
  for (const ev of events) {
    if (ev.stockId !== stockId) continue;
    const wasFlat = qty <= FLAT;
    qty = qtyAfter(qty, ev);
    if (qty < 0) qty = 0;
    if (wasFlat && qty > FLAT) opened = ev.date;
    if (qty <= FLAT) opened = null;
  }
  return opened;
}

/** Last blotter price for a stock (preview fallback when `stock_prices` has no close). */
export function lastTxPrice(events: ReplayEvent[], stockId: string): number {
  let price = 0;
  for (const ev of events) {
    if (ev.kind === "tx" && ev.stockId === stockId && ev.price > 0) price = ev.price;
  }
  return price;
}

/** Excel DATEDIF(..., "d"): calendar days from `fromIso` to `toIso` (YYYY-MM-DD). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const ymd = (s: string) => {
    const p = s.slice(0, 10).split("-").map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  };
  return Math.round((ymd(toIso) - ymd(fromIso)) / 86_400_000);
}

/** NAV weights for cash + sectors. Same denominator as phase1 holding `weight` (equity MV + cash). */
export function navAllocation(holdings: Array<{ sector: string; currentValue: number }>, cash: number) {
  const equity = holdings.reduce((s, h) => s + h.currentValue, 0);
  const nav = equity + cash;
  const sectors = new Map<string, number>();
  for (const h of holdings) {
    const key = h.sector || "Unclassified";
    sectors.set(key, (sectors.get(key) || 0) + h.currentValue);
  }
  return {
    nav: Math.round(nav * 10000) / 10000,
    cash: {
      value: Math.round(cash * 10000) / 10000,
      weight: nav > 0 ? cash / nav : 0,
    },
    sectors: [...sectors.entries()]
      .map(([sector, value]) => ({
        sector,
        value: Math.round(value * 10000) / 10000,
        weight: nav > 0 ? value / nav : 0,
      }))
      .sort((a, b) => b.value - a.value),
  };
}

/** Weighted-average qty/cost replay used by holdings valuation. Buy/transfer: qty × price (commission not applied here). */
export function applyReplayEvents(events: ReplayEvent[]): Map<string, { quantity: number; totalCost: number }> {
  const agg = new Map<string, { quantity: number; totalCost: number }>();
  for (const ev of events) {
    const prev = agg.get(ev.stockId) || { quantity: 0, totalCost: 0 };
    if (ev.kind === "tx") {
      if (!isSell(ev.type)) {
        agg.set(ev.stockId, { quantity: prev.quantity + ev.quantity, totalCost: prev.totalCost + ev.quantity * ev.price });
      } else {
        const sellQty = Math.min(ev.quantity, prev.quantity);
        const avgCost = prev.quantity > 0 ? prev.totalCost / prev.quantity : 0;
        agg.set(ev.stockId, { quantity: prev.quantity - sellQty, totalCost: prev.totalCost - sellQty * avgCost });
      }
    } else {
      agg.set(ev.stockId, {
        quantity: prev.quantity + ev.qtyDelta,
        totalCost: Math.max(0, prev.totalCost + ev.costDelta),
      });
    }
  }
  return agg;
}

/** Workbook §22: Equity / Total cost − 1. Null when cost is not positive. */
export function excelHoldingReturn(equity: number, totalCost: number): number | null {
  if (!(totalCost > 0)) return null;
  return equity / totalCost - 1;
}

/**
 * Workbook §23: `(1 + R)^(holdingDays / 365) − 1`.
 * This is **not** conventional CFA `(1+R)^(365/days)−1` (HP-CONF-02 / GOV-02).
 */
export function excelAnnualizedReturn(r: number, holdingDays: number): number | null {
  if (holdingDays < 0) return null;
  if (holdingDays === 0) return 0;
  if (!(1 + r > 0)) return null;
  return (1 + r) ** (holdingDays / 365) - 1;
}

/** Workbook §24. Null when total P/L is ~0 (workbook does not define that edge). */
export function excelReturnContribution(rowPnL: number, totalPnL: number): number | null {
  if (Math.abs(totalPnL) < 1e-12) return null;
  return rowPnL / totalPnL;
}

/**
 * Workbook Table1 totals: SUM(Equity) / SUM(Total cost) including the Cash row
 * (Cash equity = cash, Cash total cost = cash, Cash P/L = 0).
 */
export function excelEquityTotals(
  holdings: Array<{ currentValue: number; totalCost: number }>,
  cash = 0,
) {
  const equityValue = holdings.reduce((s, h) => s + h.currentValue, 0) + cash;
  const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0) + cash;
  return {
    equityValue: Math.round(equityValue * 10000) / 10000,
    totalCost: Math.round(totalCost * 10000) / 10000,
    gain: Math.round((equityValue - totalCost) * 10000) / 10000,
    growth: totalCost > 0 ? equityValue / totalCost - 1 : null,
  };
}
