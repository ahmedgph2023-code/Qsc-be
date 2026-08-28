/** Calendar date helpers (UTC date-only, YYYY-MM-DD). */

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

export function addMonths(iso: string, months: number): string {
  const d = parseDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return formatDate(d);
}

/** Exclusive end: days in [start, end). */
export function actualDaysBetween(startIso: string, endIso: string): number {
  const ms = parseDate(endIso).getTime() - parseDate(startIso).getTime();
  return Math.round(ms / 86_400_000);
}

export function compareDates(a: string, b: string): number {
  return a.slice(0, 10).localeCompare(b.slice(0, 10));
}

export function minDate(a: string, b: string): string {
  return compareDates(a, b) <= 0 ? a.slice(0, 10) : b.slice(0, 10);
}

export function maxDate(a: string, b: string): string {
  return compareDates(a, b) >= 0 ? a.slice(0, 10) : b.slice(0, 10);
}

/** Inclusive iterate from start through end (both YYYY-MM-DD). */
export function* eachDateInclusive(startIso: string, endIso: string): Generator<string> {
  let cur = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  while (compareDates(cur, end) <= 0) {
    yield cur;
    cur = addDays(cur, 1);
  }
}

/**
 * Day-count fraction for one calendar day inside a coupon period.
 *
 * ACT_PERIOD (default / required accuracy for semi-annual):
 *   Daily share = 1 / actualDaysInPeriod
 *   so periodCoupon / actualDays = exact daily increment.
 *   Months with 28/29/30/31 days are handled automatically because
 *   actualDaysBetween counts real calendar days in that coupon window.
 */
export function dayFractionForPeriodDay(
  dayCount: string,
  periodStart: string,
  periodEnd: string,
  _asOf: string,
): number {
  const days = Math.max(1, actualDaysBetween(periodStart, periodEnd));
  if (dayCount === "ACT_360") return 1 / 360;
  if (dayCount === "ACT_365") return 1 / 365;
  if (dayCount === "30_360") return 1 / 360;
  // ACT_PERIOD and ACT_ACT: allocate evenly across actual days in this coupon period
  return 1 / days;
}

export function periodsPerYear(freq: string): number {
  if (freq === "annual") return 1;
  if (freq === "quarterly") return 4;
  if (freq === "semi_annual") return 2;
  return 0; // zero
}

export function monthsPerPeriod(freq: string): number {
  if (freq === "annual") return 12;
  if (freq === "quarterly") return 3;
  if (freq === "semi_annual") return 6;
  return 0;
}
