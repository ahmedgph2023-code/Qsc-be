import { desc, eq, max, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { roundMoney, roundQar2 } from "../lib/money.js";
import { writeAudit } from "./audit.js";
import {
  loadCash,
  loadClientPortfolioSnapshots,
  loadOfficialCloses,
  loadShares,
  latestQscSnapshotDate,
  listQscSnapshotDates,
  type QscPortfolioSnapshotRow,
} from "./ext-sql-clients.js";
import { cashBalance } from "./ext-sql-portfolio.js";
import { lotsFromShares } from "./statement-portfolio.js";
import { todayQatar } from "./fee-engine.js";

/** Two display fils. Client 2026-08-30 (س-34): PortfolioValue = market value only; match status uses mvMatch. */
export const SNAPSHOT_MATCH_TOLERANCE = 0.01;

export type SnapshotMatchStatus = "matched" | "cash_only" | "mismatch" | "incomplete" | "qsc_missing";

export type SnapshotCompareInput = {
  hasQsc: boolean;
  qscPortfolioValue: number | null;
  qscSystemCash: number | null;
  ipmsMarketValue: number | null;
  ipmsCash: number;
  ipmsNavMvPlusCash: number | null;
  missingCloses: string[];
};

export type SnapshotCompareResult = {
  cashMatch: boolean | null;
  mvMatch: boolean | null;
  navMatch: boolean | null;
  bankMatch: null;
  status: SnapshotMatchStatus;
};

export type StoredSnapshotRow = {
  id: string;
  clientId: number;
  snapshotDate: string;
  nin: string | null;
  name: string | null;
  ipmsMarketValue: number | null;
  ipmsCash: number;
  ipmsNavMvPlusCash: number | null;
  missingCloses: string[];
  qscPortfolioValue: number | null;
  qscSystemCash: number | null;
  qscBankBalance: number | null;
  qscUpdatedAt: string | null;
  cashMatch: boolean | null;
  mvMatch: boolean | null;
  navMatch: boolean | null;
  bankMatch: null;
  status: SnapshotMatchStatus;
  cashDelta: number | null;
  mvDelta: number | null;
  navDelta: number | null;
};

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moneyStr(n: number | null): string | null {
  return n == null ? null : String(roundMoney(n, 4));
}

export function moneyMatches(a: number | null, b: number | null, tolerance = SNAPSHOT_MATCH_TOLERANCE): boolean | null {
  if (a == null || b == null) return null;
  const fils = Math.round(tolerance * 100);
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= fils;
}

function emptySummary(): Record<SnapshotMatchStatus | "total", number> {
  return { matched: 0, cash_only: 0, mismatch: 0, incomplete: 0, qsc_missing: 0, total: 0 };
}

export function snapshotStatus(input: SnapshotCompareInput): SnapshotMatchStatus {
  if (!input.hasQsc) return "qsc_missing";
  if (input.missingCloses.length > 0) return "incomplete";
  const compared = compareFlags(input);
  if (compared.cashMatch == null) return "incomplete";
  if (!compared.cashMatch) return "mismatch";
  const noEquity = input.ipmsMarketValue === 0;
  if (noEquity) {
    if (compared.mvMatch === true) return "cash_only";
    return "mismatch";
  }
  if (compared.mvMatch === true) return "matched";
  return "mismatch";
}

function compareFlags(input: SnapshotCompareInput): Pick<SnapshotCompareResult, "cashMatch" | "mvMatch" | "navMatch"> {
  return {
    cashMatch: moneyMatches(input.qscSystemCash, input.ipmsCash),
    mvMatch: moneyMatches(input.qscPortfolioValue, input.ipmsMarketValue),
    navMatch: moneyMatches(input.qscPortfolioValue, input.ipmsNavMvPlusCash),
  };
}

export function compareSnapshot(input: SnapshotCompareInput): SnapshotCompareResult {
  const flags = compareFlags(input);
  return {
    ...flags,
    bankMatch: null,
    status: snapshotStatus(input),
  };
}

export function ipmsMarketValue(
  lots: Array<{ ticker: string; quantity: number }>,
  closes: Map<string, { price: number }>,
): { marketValue: number | null; missingCloses: string[] } {
  const missing: string[] = [];
  let mv = 0;
  for (const lot of lots) {
    const ticker = lot.ticker.trim();
    if (!ticker) continue;
    const close = closes.get(ticker);
    if (!close) {
      missing.push(ticker);
      continue;
    }
    mv = roundMoney(mv + lot.quantity * close.price, 4);
  }
  if (missing.length > 0) return { marketValue: null, missingCloses: [...new Set(missing)].sort() };
  return { marketValue: roundMoney(mv, 4), missingCloses: [] };
}

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return roundQar2(a - b);
}

async function maxOfficialCloseDate(): Promise<string | null> {
  const [row] = await db.select({ maxDate: max(schema.stockPrices.date) }).from(schema.stockPrices);
  return row?.maxDate ? String(row.maxDate).slice(0, 10) : null;
}

export type SnapshotDateCount = { date: string; rows: number; lastUpdated: string | null };

async function listStoredSnapshotDates(): Promise<string[]> {
  const rows = await db.select({ d: schema.ipmsClientSnapshots.snapshotDate })
    .from(schema.ipmsClientSnapshots)
    .groupBy(schema.ipmsClientSnapshots.snapshotDate)
    .orderBy(desc(schema.ipmsClientSnapshots.snapshotDate));
  return rows.map((r) => String(r.d).slice(0, 10));
}

async function snapshotDateMeta(): Promise<{
  latestQscDate: string | null;
  qscDates: SnapshotDateCount[];
  storedDates: string[];
  maxOfficialCloseDate: string | null;
}> {
  const [latestQscDate, qscDates, storedDates, officialCloseDate] = await Promise.all([
    latestQscSnapshotDate().catch(() => null),
    listQscSnapshotDates().catch(() => [] as SnapshotDateCount[]),
    listStoredSnapshotDates(),
    maxOfficialCloseDate(),
  ]);
  return { latestQscDate, qscDates, storedDates, maxOfficialCloseDate: officialCloseDate };
}

function toStored(row: typeof schema.ipmsClientSnapshots.$inferSelect): StoredSnapshotRow {
  const ipmsMv = numOrNull(row.ipmsMarketValue);
  const ipmsCash = Number(row.ipmsCash ?? 0);
  const ipmsNav = numOrNull(row.ipmsNavMvPlusCash);
  const qscPv = numOrNull(row.qscPortfolioValue);
  const qscCash = numOrNull(row.qscSystemCash);
  return {
    id: row.id,
    clientId: row.clientId,
    snapshotDate: String(row.snapshotDate).slice(0, 10),
    nin: row.nin,
    name: row.name,
    ipmsMarketValue: ipmsMv,
    ipmsCash,
    ipmsNavMvPlusCash: ipmsNav,
    missingCloses: Array.isArray(row.missingCloses) ? row.missingCloses : [],
    qscPortfolioValue: qscPv,
    qscSystemCash: qscCash,
    qscBankBalance: numOrNull(row.qscBankBalance),
    qscUpdatedAt: row.qscUpdatedAt ? new Date(row.qscUpdatedAt).toISOString() : null,
    cashMatch: row.cashMatch,
    mvMatch: row.mvMatch,
    navMatch: row.navMatch,
    bankMatch: null,
    status: row.status as SnapshotMatchStatus,
    cashDelta: delta(qscCash, ipmsCash),
    mvDelta: delta(qscPv, ipmsMv),
    navDelta: delta(qscPv, ipmsNav),
  };
}

export async function listStoredSnapshots(asOf: string): Promise<{
  asOf: string;
  latestQscDate: string | null;
  qscDates: SnapshotDateCount[];
  storedDates: string[];
  maxOfficialCloseDate: string | null;
  rows: StoredSnapshotRow[];
  summary: Record<SnapshotMatchStatus | "total", number>;
}> {
  const [rows, meta] = await Promise.all([
    db.select().from(schema.ipmsClientSnapshots)
      .where(eq(schema.ipmsClientSnapshots.snapshotDate, asOf))
      .orderBy(schema.ipmsClientSnapshots.clientId),
    snapshotDateMeta(),
  ]);
  const mapped = rows.map(toStored);
  const summary = emptySummary();
  for (const r of mapped) summary[r.status] += 1;
  summary.total = mapped.length;
  return { asOf, ...meta, rows: mapped, summary };
}

export async function runDailySnapshot(asOf = todayQatar(), userId?: string | null): Promise<{
  asOf: string;
  qscRowCount: number;
  stored: number;
  latestQscDate: string | null;
  qscDates: SnapshotDateCount[];
  storedDates: string[];
  maxOfficialCloseDate: string | null;
  summary: Record<SnapshotMatchStatus | "total", number>;
}> {
  const [sqlRows, meta] = await Promise.all([
    loadClientPortfolioSnapshots(asOf),
    snapshotDateMeta(),
  ]);

  if (sqlRows.length === 0) {
    return {
      asOf,
      qscRowCount: 0,
      stored: 0,
      ...meta,
      summary: emptySummary(),
    };
  }

  const emptySectors = new Map<string, string>();
  const emptyNames = new Map<string, string>();
  const ledgers: Array<{
    snap: QscPortfolioSnapshotRow;
    lots: Array<{ ticker: string; quantity: number }>;
    ipmsCash: number;
    nin: string | null;
  }> = [];

  for (const snap of sqlRows) {
    const [shares, cash] = await Promise.all([loadShares(snap.clientId, asOf), loadCash(snap.clientId, asOf)]);
    const lots = lotsFromShares(shares, asOf, emptySectors, emptyNames);
    ledgers.push({
      snap,
      lots,
      ipmsCash: roundMoney(cashBalance(cash, asOf), 4),
      nin: shares[0]?.nin || cash[0]?.nin || null,
    });
  }

  const tickers = [...new Set(ledgers.flatMap((l) => l.lots.map((lot) => lot.ticker.trim()).filter(Boolean)))];
  await db.execute(sql`select 1`);
  const closes = await loadOfficialCloses(tickers, asOf);

  const summary = emptySummary();

  for (const row of ledgers) {
    const valued = ipmsMarketValue(row.lots, closes);
    const ipmsNav = valued.marketValue == null ? null : roundMoney(valued.marketValue + row.ipmsCash, 4);
    const compared = compareSnapshot({
      hasQsc: true,
      qscPortfolioValue: row.snap.portfolioValue,
      qscSystemCash: row.snap.systemCash,
      ipmsMarketValue: valued.marketValue,
      ipmsCash: row.ipmsCash,
      ipmsNavMvPlusCash: ipmsNav,
      missingCloses: valued.missingCloses,
    });
    summary[compared.status] += 1;
    summary.total += 1;

    await db.insert(schema.ipmsClientSnapshots).values({
      clientId: row.snap.clientId,
      snapshotDate: asOf,
      nin: row.nin,
      name: row.snap.name,
      ipmsMarketValue: moneyStr(valued.marketValue),
      ipmsCash: String(row.ipmsCash),
      ipmsNavMvPlusCash: moneyStr(ipmsNav),
      missingCloses: valued.missingCloses,
      qscPortfolioValue: moneyStr(row.snap.portfolioValue),
      qscSystemCash: moneyStr(row.snap.systemCash),
      qscBankBalance: moneyStr(row.snap.bankBalance),
      qscUpdatedAt: row.snap.updatedAt,
      cashMatch: compared.cashMatch,
      mvMatch: compared.mvMatch,
      navMatch: compared.navMatch,
      status: compared.status,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.ipmsClientSnapshots.clientId, schema.ipmsClientSnapshots.snapshotDate],
      set: {
        nin: sql`excluded.nin`,
        name: sql`excluded.name`,
        ipmsMarketValue: sql`excluded.ipms_market_value`,
        ipmsCash: sql`excluded.ipms_cash`,
        ipmsNavMvPlusCash: sql`excluded.ipms_nav_mv_plus_cash`,
        missingCloses: sql`excluded.missing_closes`,
        qscPortfolioValue: sql`excluded.qsc_portfolio_value`,
        qscSystemCash: sql`excluded.qsc_system_cash`,
        qscBankBalance: sql`excluded.qsc_bank_balance`,
        qscUpdatedAt: sql`excluded.qsc_updated_at`,
        cashMatch: sql`excluded.cash_match`,
        mvMatch: sql`excluded.mv_match`,
        navMatch: sql`excluded.nav_match`,
        status: sql`excluded.status`,
        updatedAt: new Date(),
      },
    });
  }

  await writeAudit({
    userId: userId ?? null,
    action: "create",
    objectType: "ipms_client_snapshot",
    objectId: null,
    newValue: { asOf, stored: summary.total, qscRowCount: sqlRows.length },
    reason: "Daily SQL vs IPMS snapshot compare",
  });

  const storedDates = await listStoredSnapshotDates();
  return { asOf, qscRowCount: sqlRows.length, stored: summary.total, ...meta, storedDates, summary };
}

export { latestQscSnapshotDate };
