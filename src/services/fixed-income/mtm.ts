import { compareDates } from "./day-count.js";
import type { DailyBookRow } from "./accrual.js";

export type PricePoint = { date: string; price: number };

/** Resolve clean price (% of par) on or before asOf. */
export function priceOnOrBefore(prices: PricePoint[], asOf: string): { price: number; date: string; stale: boolean } | null {
  const d = asOf.slice(0, 10);
  let best: PricePoint | null = null;
  for (const p of prices) {
    if (compareDates(p.date, d) <= 0) {
      if (!best || compareDates(p.date, best.date) > 0) best = p;
    }
  }
  if (!best) return null;
  return { price: best.price, date: best.date, stale: best.date !== d };
}

export type DailyMtmRow = {
  asOfDate: string;
  cleanPrice: number | null;
  dirtyPrice: number | null;
  marketValue: number | null;
  mtmPnl: number;
  priceStale: boolean;
};

/**
 * MTM overlay on top of book rows.
 * dirty ≈ clean + accruedPerPar (accruedInterest / units expressed per par already in book row as cash).
 */
export function attachMtm(input: {
  bookRows: DailyBookRow[];
  faceAmount: number;
  facePar: number;
  prices: PricePoint[];
  /** Accrued per par already embedded as accruedInterest / units */
}): DailyMtmRow[] {
  const units = input.faceAmount / input.facePar;
  let prevDirtyMv: number | null = null;

  return input.bookRows.map((row) => {
    const px = priceOnOrBefore(input.prices, row.asOfDate);
    const accruedPerPar = units > 0 ? row.accruedInterest / units : 0;

    if (!px) {
      return {
        asOfDate: row.asOfDate,
        cleanPrice: null,
        dirtyPrice: null,
        marketValue: null,
        mtmPnl: 0,
        priceStale: true,
      };
    }

    const clean = px.price;
    const dirty = clean + accruedPerPar;
    const marketValue = units * dirty;
    // MTM day P&L = change in dirty MV; coupon cash is separate (already in book)
    let mtmPnl = 0;
    if (prevDirtyMv != null) {
      mtmPnl = marketValue - prevDirtyMv + row.couponCash;
      // Adding couponCash: when price drops by coupon on ex/pay, MV falls but cash offsets
    }
    prevDirtyMv = marketValue - row.couponCash; // after cash leave, dirty continues without that coupon

    return {
      asOfDate: row.asOfDate,
      cleanPrice: round6(clean),
      dirtyPrice: round6(dirty),
      marketValue: round8(marketValue),
      mtmPnl: round8(mtmPnl),
      priceStale: px.stale,
    };
  });
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
function round8(n: number) {
  return Math.round(n * 1e8) / 1e8;
}
