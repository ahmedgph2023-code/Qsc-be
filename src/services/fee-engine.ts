import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { signedCashDelta } from "./cash-sign.js";
import { loadAppliedCaDeltas } from "./corporate-action-portfolio.js";
import { isSell } from "../lib/tx-type.js";

const tn = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function txDate(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}

export function monthKeyFromDate(iso: string): string {
  return iso.slice(0, 7);
}

export function monthStart(ym: string): string {
  return `${ym}-01`;
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function todayQatar(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Qatar" });
}

export function previousMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function eachMonth(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4));
  let m = Number(fromYm.slice(5, 7));
  const endY = Number(toYm.slice(0, 4));
  const endM = Number(toYm.slice(5, 7));
  if (!y || !m || !endY || !endM || fromYm > toYm) return out;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Inclusive calendar-day count between YYYY-MM-DD dates (UTC date parts). */
export function calendarDaysInclusive(from: string, to: string): number {
  if (to < from) return 0;
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000) + 1;
}

export function addCalendarDays(iso: string, delta: number): string {
  const d = new Date(Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  ));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysInCalendarMonth(ym: string): number {
  return calendarDaysInclusive(monthStart(ym), monthEnd(ym));
}

export type FeeNavSegment = { from: string; to: string; nav: number };

/**
 * Contiguous NAV segments for day-weighted management fees.
 * Change dates (funding, withdrawal, trade, in-kind transfer, CA) split the month;
 * each segment is valued at its end date (prices as-of that day).
 */
export function buildFeeNavSegments(
  from: string,
  to: string,
  changeDates: string[],
  navAsOf: (iso: string) => number,
): FeeNavSegment[] {
  if (to < from) return [];
  const changes = [...new Set(changeDates.filter((d) => d >= from && d <= to))].sort();
  const segments: FeeNavSegment[] = [];
  let cursor = from;
  for (const change of changes) {
    if (change > cursor) {
      const segEnd = addCalendarDays(change, -1);
      segments.push({ from: cursor, to: segEnd, nav: navAsOf(segEnd) });
      cursor = change;
    }
  }
  segments.push({ from: cursor, to, nav: navAsOf(to) });
  return segments;
}

/**
 * Management fee = (Σ NAV_i × days_i / daysInMonth) × annualPct / 100 / 12
 * Matches QSC ops: do not charge the post-top-up NAV from the first of the month.
 */
export function dayWeightedManagementFeeAmount(
  segments: FeeNavSegment[],
  annualPct: number,
  daysInMonth: number,
): { avgNav: number; amount: number; weightedNavDays: number } {
  if (annualPct <= 0 || daysInMonth <= 0) {
    return { avgNav: 0, amount: 0, weightedNavDays: 0 };
  }
  let weightedNavDays = 0;
  for (const s of segments) {
    const days = calendarDaysInclusive(s.from, s.to);
    if (days > 0) weightedNavDays += s.nav * days;
  }
  const avgNav = round4(weightedNavDays / daysInMonth);
  const amount = round2(avgNav * annualPct / 100 / 12);
  return { avgNav, amount, weightedNavDays };
}

/** Performance only on NAV above HWM (and optional hurdle NAV). excess ≤ 0 → no charge. */
export function performanceFeeAmount(
  navPerf: number,
  hwm: number,
  perfPct: number,
  hurdlePct = 0,
): {
  excess: number;
  amount: number;
  chargeBase: number;
} {
  // Hurdle raises the floor above HWM: chargeBase = HWM × (1 + hurdle%/100). Hurdle 0 → HWM only (D-008).
  const chargeBase = hurdlePct > 0 ? round4(hwm * (1 + hurdlePct / 100)) : hwm;
  const excess = round4(navPerf - chargeBase);
  const amount = excess > 0 && perfPct > 0 ? round2(excess * perfPct / 100) : 0;
  return { excess, amount, chargeBase };
}

export async function monthsCoveredByMandateBands(
  mandateId: string,
  opts?: { includeIncomplete?: boolean },
): Promise<string[]> {
  const bands = await db.select().from(schema.mandateFeeBands)
    .where(eq(schema.mandateFeeBands.mandateId, mandateId));
  if (!bands.length) return [];
  const today = todayQatar();
  const cap = opts?.includeIncomplete ? today.slice(0, 7) : previousMonth(today.slice(0, 7));
  const start = bands.map((b) => monthKeyFromDate(String(b.effectiveFrom))).sort()[0];
  let end = bands
    .map((b) => (b.effectiveTo ? monthKeyFromDate(String(b.effectiveTo)) : cap))
    .sort()
    .at(-1)!;
  if (end > cap) end = cap;
  if (!start || start > end) return [];
  return eachMonth(start, end);
}

function dateInBand(iso: string, from: string, to: string | null): boolean {
  if (iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

function bandsOverlap(
  aFrom: string, aTo: string | null,
  bFrom: string, bTo: string | null,
): boolean {
  const aEnd = aTo || "9999-12-31";
  const bEnd = bTo || "9999-12-31";
  return aFrom <= bEnd && bFrom <= aEnd;
}

export function assertNoBandOverlap(
  existing: { id?: string; effectiveFrom: string; effectiveTo: string | null }[],
  next: { id?: string; effectiveFrom: string; effectiveTo: string | null },
) {
  for (const b of existing) {
    if (next.id && b.id === next.id) continue;
    if (bandsOverlap(next.effectiveFrom, next.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
      const err: any = new Error("Fee band dates overlap an existing band");
      err.status = 400;
      throw err;
    }
  }
}

function isCrystallisation(
  frequency: "annual" | "quarterly",
  periodEnd: string,
  bandFrom: string,
): boolean {
  const month = Number(periodEnd.slice(5, 7));
  if (frequency === "quarterly") return [3, 6, 9, 12].includes(month);
  return periodEnd.slice(5, 7) === bandFrom.slice(5, 7);
}

async function bandForDate(mandateId: string, iso: string) {
  const bands = await db.select().from(schema.mandateFeeBands)
    .where(eq(schema.mandateFeeBands.mandateId, mandateId))
    .orderBy(asc(schema.mandateFeeBands.effectiveFrom));
  return bands.find((b) => dateInBand(iso, String(b.effectiveFrom), b.effectiveTo ? String(b.effectiveTo) : null)) || null;
}

async function holdingsMvAsOf(portfolioId: string, asOf: string): Promise<number> {
  const txs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.portfolioId, portfolioId))
    .orderBy(asc(schema.transactions.timestamp));
  const apps = await loadAppliedCaDeltas(portfolioId);

  const qty = new Map<string, number>();
  type Ev = { date: string; sort: number; stockId: string; delta: number };
  const events: Ev[] = [];
  for (const tx of txs) {
    const d = txDate(tx.timestamp);
    if (d > asOf) continue;
    const q = tn(tx.quantity);
    events.push({ date: d, sort: 0, stockId: tx.stockId, delta: isSell(tx.type) ? -q : q });
  }
  for (const app of apps) {
    const d = String(app.actionDate).slice(0, 10);
    if (d > asOf) continue;
    events.push({ date: d, sort: 1, stockId: app.stockId, delta: tn(app.qtyDelta) });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);
  for (const ev of events) {
    qty.set(ev.stockId, Math.max(0, (qty.get(ev.stockId) || 0) + ev.delta));
  }

  let mv = 0;
  for (const [stockId, q] of qty) {
    if (q < 1e-8) continue;
    const rows = await db.select({ price: schema.stockPrices.price })
      .from(schema.stockPrices)
      .where(and(eq(schema.stockPrices.stockId, stockId), lte(schema.stockPrices.date, asOf)))
      .orderBy(sql`${schema.stockPrices.date} desc`)
      .limit(1);
    mv += q * tn(rows[0]?.price);
  }
  return round4(mv);
}

async function cashAsOf(portfolioId: string, asOf: string): Promise<number> {
  const rows = await db.select().from(schema.cashTransactions)
    .where(and(
      eq(schema.cashTransactions.portfolioId, portfolioId),
      lte(schema.cashTransactions.tradeDate, asOf),
    ));
  let bal = 0;
  for (const r of rows) bal += signedCashDelta(r.type, tn(r.amount));
  return round4(bal);
}

async function monthNotional(portfolioId: string, ym: string): Promise<number> {
  const start = monthStart(ym);
  const end = monthEnd(ym);
  const txs = await db.select().from(schema.transactions)
    .where(and(
      eq(schema.transactions.portfolioId, portfolioId),
      gte(schema.transactions.timestamp, new Date(`${start}T00:00:00.000Z`)),
      lte(schema.transactions.timestamp, new Date(`${end}T23:59:59.999Z`)),
    ));
  let n = 0;
  for (const tx of txs) {
    if (tx.type === "CLIENT_TRANSFER") continue;
    n += Math.abs(tn(tx.quantity) * tn(tx.price));
  }
  return round4(n);
}

async function portfolioNavAsOf(portfolioId: string, asOf: string): Promise<number> {
  const mv = await holdingsMvAsOf(portfolioId, asOf);
  const cash = await cashAsOf(portfolioId, asOf);
  return round4(mv + cash);
}

/** Dates that change cash or holdings (and thus fee AUM) inside [from, to]. */
async function feeNavChangeDates(portfolioId: string, from: string, to: string): Promise<string[]> {
  const dates = new Set<string>();

  const txs = await db.select({ timestamp: schema.transactions.timestamp })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.portfolioId, portfolioId),
      gte(schema.transactions.timestamp, new Date(`${from}T00:00:00.000Z`)),
      lte(schema.transactions.timestamp, new Date(`${to}T23:59:59.999Z`)),
    ));
  for (const tx of txs) dates.add(txDate(tx.timestamp));

  const cashRows = await db.select({ tradeDate: schema.cashTransactions.tradeDate })
    .from(schema.cashTransactions)
    .where(and(
      eq(schema.cashTransactions.portfolioId, portfolioId),
      gte(schema.cashTransactions.tradeDate, from),
      lte(schema.cashTransactions.tradeDate, to),
    ));
  for (const r of cashRows) dates.add(String(r.tradeDate).slice(0, 10));

  const apps = await loadAppliedCaDeltas(portfolioId);
  for (const app of apps) {
    const d = String(app.actionDate).slice(0, 10);
    if (d >= from && d <= to) dates.add(d);
  }

  return [...dates].sort();
}

async function dayWeightedNavForMonth(
  portfolioId: string,
  ym: string,
  feeThrough: string,
  bandFrom: string,
): Promise<{ avgNav: number; segments: FeeNavSegment[]; daysInMonth: number; feeFrom: string; feeTo: string }> {
  const monthFirst = monthStart(ym);
  const daysInMonth = daysInCalendarMonth(ym);
  const feeFrom = bandFrom > monthFirst ? bandFrom : monthFirst;
  const feeTo = feeThrough;
  if (feeTo < feeFrom) {
    return { avgNav: 0, segments: [], daysInMonth, feeFrom, feeTo };
  }

  const changes = await feeNavChangeDates(portfolioId, feeFrom, feeTo);
  const cache = new Map<string, number>();

  const boundaryDates = new Set<string>([feeTo]);
  for (const c of changes) {
    if (c > feeFrom) boundaryDates.add(addCalendarDays(c, -1));
    boundaryDates.add(c);
  }
  for (const d of [...boundaryDates].sort()) {
    if (d >= feeFrom && d <= feeTo) {
      cache.set(d, await portfolioNavAsOf(portfolioId, d));
    }
  }

  const segments = buildFeeNavSegments(
    feeFrom,
    feeTo,
    changes,
    (iso) => cache.get(iso) ?? 0,
  );
  for (const s of segments) {
    if (!cache.has(s.to)) {
      cache.set(s.to, await portfolioNavAsOf(portfolioId, s.to));
    }
    s.nav = cache.get(s.to)!;
  }

  let weightedNavDays = 0;
  for (const s of segments) {
    const days = calendarDaysInclusive(s.from, s.to);
    if (days > 0) weightedNavDays += s.nav * days;
  }
  const avgNav = daysInMonth > 0 ? round4(weightedNavDays / daysInMonth) : 0;
  return { avgNav, segments, daysInMonth, feeFrom, feeTo };
}

async function clearPendingCharge(
  portfolioId: string,
  periodMonth: string,
  type: "rebate_commission" | "management_fee" | "performance_fee",
) {
  const existing = await db.select().from(schema.feeCharges).where(and(
    eq(schema.feeCharges.portfolioId, portfolioId),
    eq(schema.feeCharges.periodMonth, periodMonth),
    eq(schema.feeCharges.type, type),
  )).limit(1);
  if (!existing[0] || existing[0].status !== "pending") return null;
  await db.delete(schema.feeCharges).where(eq(schema.feeCharges.id, existing[0].id));
  return { action: "cleared" as const, id: existing[0].id, type };
}

type UpsertCharge = {
  portfolioId: string;
  customerId: string;
  mandateId: string;
  feeBandId: string;
  type: "rebate_commission" | "management_fee" | "performance_fee";
  periodMonth: string;
  periodEndDate: string;
  notional: number;
  holdingsMv: number;
  cashAsOf: number;
  nav: number;
  ratePct: number;
  amount: number;
  hwmBefore?: number | null;
  excess?: number | null;
  twrPct?: number | null;
  notes?: string | null;
};

async function upsertPending(row: UpsertCharge) {
  const existing = await db.select().from(schema.feeCharges).where(and(
    eq(schema.feeCharges.portfolioId, row.portfolioId),
    eq(schema.feeCharges.periodMonth, row.periodMonth),
    eq(schema.feeCharges.type, row.type),
  )).limit(1);

  const payload = {
    customerId: row.customerId,
    mandateId: row.mandateId,
    feeBandId: row.feeBandId,
    periodEndDate: row.periodEndDate,
    notional: String(row.notional),
    holdingsMv: String(row.holdingsMv),
    cashAsOf: String(row.cashAsOf),
    nav: String(row.nav),
    ratePct: String(row.ratePct),
    amount: String(row.amount),
    hwmBefore: row.hwmBefore != null ? String(row.hwmBefore) : null,
    excess: row.excess != null ? String(row.excess) : null,
    twrPct: row.twrPct != null ? String(row.twrPct) : null,
    notes: row.notes ?? null,
    updatedAt: new Date(),
  };

  if (existing[0]) {
    if (existing[0].status !== "pending") return { action: "skipped" as const, id: existing[0].id, type: row.type };
    const [updated] = await db.update(schema.feeCharges).set(payload)
      .where(eq(schema.feeCharges.id, existing[0].id)).returning();
    return { action: "updated" as const, id: updated.id, type: row.type, amount: row.amount };
  }

  const [created] = await db.insert(schema.feeCharges).values({
    portfolioId: row.portfolioId,
    type: row.type,
    periodMonth: row.periodMonth,
    status: "pending",
    ...payload,
  }).returning();
  return { action: "created" as const, id: created.id, type: row.type, amount: row.amount };
}

export async function generateFeeChargesForPortfolio(
  portfolioId: string,
  months: string[],
  opts?: { includeIncomplete?: boolean },
) {
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolio) {
    const err: any = new Error("Portfolio not found");
    err.status = 404;
    throw err;
  }
  const [mandate] = await db.select().from(schema.mandates)
    .where(eq(schema.mandates.customerId, portfolio.customerId)).limit(1);
  if (!mandate) {
    const err: any = new Error("Mandate not found — add a mandate before generating fees");
    err.status = 400;
    throw err;
  }
  const [anyBand] = await db.select({ id: schema.mandateFeeBands.id })
    .from(schema.mandateFeeBands)
    .where(eq(schema.mandateFeeBands.mandateId, mandate.id))
    .limit(1);
  if (!anyBand) {
    const err: any = new Error("Add a fee band with dates, commission, management, and performance before calculating");
    err.status = 400;
    throw err;
  }

  const today = todayQatar();
  const results: { action: string; id: string; type: string; amount?: number }[] = [];
  let ymList = [...new Set(months.map((m) => m.slice(0, 7)))].sort();
  if (!ymList.length) {
    ymList = await monthsCoveredByMandateBands(mandate.id, opts);
  }

  for (const ym of ymList) {
    const monthLast = monthEnd(ym);
    if (!opts?.includeIncomplete && monthLast > today) continue;
    const feeThrough = monthLast > today ? today : monthLast;

    const band = await bandForDate(mandate.id, feeThrough);
    if (!band) continue;

    const rebatePct = tn(band.rebateCommissionPct);
    const mgmtPct = tn(band.annualManagementFeePct);
    const perfPct = tn(band.performanceFeePct);
    const hwm = tn(band.highWaterMark);

    const notional = await monthNotional(portfolioId, ym);
    const holdingsMv = await holdingsMvAsOf(portfolioId, feeThrough);
    const cash = await cashAsOf(portfolioId, feeThrough);
    const rebateAmt = rebatePct > 0 ? round2(notional * rebatePct / 100) : 0;

    const weighted = await dayWeightedNavForMonth(
      portfolioId,
      ym,
      feeThrough,
      String(band.effectiveFrom).slice(0, 10),
    );
    // Rebate is a month-level credit into the management base (same as prior engine), not day-sliced.
    const avgNavMgmt = round4(weighted.avgNav + rebateAmt);
    const managementAmount = mgmtPct > 0 ? round2(avgNavMgmt * mgmtPct / 100 / 12) : 0;

    const segmentNote = weighted.segments
      .map((s) => `${s.from}..${s.to}:${round2(s.nav)}`)
      .join("; ");

    const navMonthEnd = round4(holdingsMv + cash + rebateAmt);

    if (rebateAmt > 0) {
      results.push(await upsertPending({
        portfolioId,
        customerId: portfolio.customerId,
        mandateId: mandate.id,
        feeBandId: band.id,
        type: "rebate_commission",
        periodMonth: monthStart(ym),
        periodEndDate: feeThrough,
        notional,
        holdingsMv,
        cashAsOf: cash,
        nav: navMonthEnd,
        ratePct: rebatePct,
        amount: rebateAmt,
        notes: `Rebate commission ${ym}`,
      }));
    }

    if (mgmtPct > 0 && (managementAmount > 0 || avgNavMgmt > 0)) {
      results.push(await upsertPending({
        portfolioId,
        customerId: portfolio.customerId,
        mandateId: mandate.id,
        feeBandId: band.id,
        type: "management_fee",
        periodMonth: monthStart(ym),
        periodEndDate: feeThrough,
        notional,
        holdingsMv,
        cashAsOf: cash,
        nav: avgNavMgmt,
        ratePct: mgmtPct,
        amount: managementAmount,
        notes: `Management fee ${ym} (day-weighted avg NAV; daysInMonth=${weighted.daysInMonth}; ${segmentNote})`,
      }));
    } else if (mgmtPct > 0 && managementAmount <= 0) {
      const cleared = await clearPendingCharge(portfolioId, monthStart(ym), "management_fee");
      if (cleared) results.push(cleared);
    }

    const freq = band.performanceFrequency;
    if (perfPct > 0 && isCrystallisation(freq, monthLast, String(band.effectiveFrom))) {
      const navPerf = round4(navMonthEnd - managementAmount);
      const hurdlePct = tn(band.performanceHurdlePct);
      const { excess, amount: perfAmt, chargeBase } = performanceFeeAmount(navPerf, hwm, perfPct, hurdlePct);
      if (perfAmt > 0) {
        results.push(await upsertPending({
          portfolioId,
          customerId: portfolio.customerId,
          mandateId: mandate.id,
          feeBandId: band.id,
          type: "performance_fee",
          periodMonth: monthStart(ym),
          periodEndDate: feeThrough,
          notional,
          holdingsMv,
          cashAsOf: cash,
          nav: navPerf,
          ratePct: perfPct,
          amount: perfAmt,
          hwmBefore: hwm,
          excess,
          notes: `Performance fee ${ym} (${freq}; chargeBase=${chargeBase}${hurdlePct > 0 ? `; hurdle ${hurdlePct}%` : ""})`,
        }));
      } else {
        const cleared = await clearPendingCharge(portfolioId, monthStart(ym), "performance_fee");
        if (cleared) {
          results.push({
            ...cleared,
            amount: 0,
          });
        }
      }
    }
  }

  return { portfolioId, generated: results };
}

export async function generateFeeChargesForMonth(ym: string) {
  const portfolios = await db.select().from(schema.portfolios).where(eq(schema.portfolios.status, "active"));
  const out = [];
  for (const p of portfolios) {
    out.push(await generateFeeChargesForPortfolio(p.id, [ym]));
  }
  return out;
}

export async function adjustActiveBandHwm(customerId: string, delta: number, asOf: string) {
  if (!delta) return;
  const [mandate] = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, customerId)).limit(1);
  if (!mandate) return;
  const band = await bandForDate(mandate.id, asOf);
  if (!band) return;
  const next = Math.max(0, round4(tn(band.highWaterMark) + delta));
  await db.update(schema.mandateFeeBands).set({
    highWaterMark: String(next),
    updatedAt: new Date(),
  }).where(eq(schema.mandateFeeBands.id, band.id));
}

export { bandsOverlap };
