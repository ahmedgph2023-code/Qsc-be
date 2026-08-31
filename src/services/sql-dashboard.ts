/**
 * Firm command-center numbers from live QSC SQL (ClientPortfolioSnapshot),
 * not the demo Postgres portfolio book.
 */
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { isExtSqlConfigured } from "../db/mssql.js";
import { roundMoney } from "../lib/money.js";
import {
  latestQscSnapshotDate,
  listExtClients,
  listQscSnapshotDates,
  loadClientPortfolioSnapshots,
} from "./ext-sql-clients.js";

const TRAJECTORY_DAYS = 14;
const TOP_CLIENTS = 8;
const INDEX_POINTS = 60;

function sumNullable(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) total += v;
  }
  return roundMoney(total, 4);
}

async function aggregateSnapshotDay(asOf: string) {
  const rows = await loadClientPortfolioSnapshots(asOf);
  const portfolioValue = sumNullable(rows.map((r) => r.portfolioValue));
  const systemCash = sumNullable(rows.map((r) => r.systemCash));
  const withEquity = rows.filter((r) => (r.portfolioValue ?? 0) > 0.01).length;
  const cashOnly = rows.filter(
    (r) => (r.portfolioValue ?? 0) <= 0.01 && Math.abs(r.systemCash ?? 0) > 0.01,
  ).length;
  return {
    asOf,
    clientCount: rows.length,
    portfolioValue,
    systemCash,
    withEquity,
    cashOnly,
    rows,
  };
}

async function loadIndexSpark(name: string) {
  const idx = await db.select().from(schema.indices).where(eq(schema.indices.name, name)).limit(1);
  if (!idx[0]) return null;
  const points = await db
    .select({
      date: schema.indexDataPoints.date,
      value: schema.indexDataPoints.value,
    })
    .from(schema.indexDataPoints)
    .where(eq(schema.indexDataPoints.indexId, idx[0].id))
    .orderBy(desc(schema.indexDataPoints.date))
    .limit(INDEX_POINTS);
  const series = [...points]
    .reverse()
    .map((p) => ({ date: String(p.date), value: Number(p.value) }))
    .filter((p) => Number.isFinite(p.value));
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  const changePct = first === 0 ? null : ((last - first) / Math.abs(first)) * 100;
  return {
    id: idx[0].id,
    name: idx[0].name,
    last,
    changePct: changePct == null ? null : Math.round(changePct * 100) / 100,
    series,
  };
}

export async function getSqlFirmOverview(asOf?: string) {
  if (!isExtSqlConfigured()) {
    const err = new Error("External SQL is not configured") as Error & { status: number; code: string };
    err.status = 503;
    err.code = "EXT_SQL_UNCONFIGURED";
    throw err;
  }

  const qscDates = await listQscSnapshotDates();
  const resolvedAsOf = asOf || qscDates[0]?.date || (await latestQscSnapshotDate());
  if (!resolvedAsOf) {
    return {
      source: "sql" as const,
      configured: true,
      asOf: null as string | null,
      qscDates,
      metrics: {
        totalPortfolioValue: 0,
        totalSystemCash: 0,
        totalNavDisplay: 0,
        activeClients: 0,
        avgPortfolioSize: 0,
        clientsWithShares: 0,
        clientsCashOnly: 0,
        ledgerClients: 0,
        shareTxRows: 0,
        cashTxRows: 0,
        pvDelta: null as number | null,
        pvDeltaPct: null as number | null,
        cashDelta: null as number | null,
      },
      trajectory: [] as Array<{ date: string; portfolioValue: number; systemCash: number; navDisplay: number }>,
      topClients: [] as Array<{
        clientId: number;
        name: string;
        nameEn: string;
        nameAr: string;
        portfolioValue: number;
        systemCash: number;
      }>,
      mix: { equity: 0, cash: 0 },
      indices: { dsm: null as Awaited<ReturnType<typeof loadIndexSpark>>, qeri: null as Awaited<ReturnType<typeof loadIndexSpark>> },
    };
  }

  const dateWindow = qscDates
    .map((d) => d.date)
    .filter(Boolean)
    .slice(0, TRAJECTORY_DAYS)
    .reverse();

  // Sequential MSSQL reads — pool max is 10; a parallel date burst plus listExtClients
  // used to starve connections while Clients (one query) still succeeded.
  const dayAggs = [];
  for (const d of dateWindow) {
    dayAggs.push(await aggregateSnapshotDay(d));
  }
  const latest = dayAggs.find((d) => d.asOf === resolvedAsOf) ?? (await aggregateSnapshotDay(resolvedAsOf));
  const prior = dayAggs.length >= 2 ? dayAggs[dayAggs.length - 2] : null;

  const trajectory = dayAggs.map((d) => ({
    date: d.asOf,
    portfolioValue: d.portfolioValue,
    systemCash: d.systemCash,
    navDisplay: roundMoney(d.portfolioValue + d.systemCash, 4),
  }));

  const pvDelta =
    prior == null ? null : roundMoney(latest.portfolioValue - prior.portfolioValue, 4);
  const pvDeltaPct =
    prior == null || prior.portfolioValue === 0
      ? null
      : Math.round(((latest.portfolioValue - prior.portfolioValue) / Math.abs(prior.portfolioValue)) * 10000) / 100;
  const cashDelta =
    prior == null ? null : roundMoney(latest.systemCash - prior.systemCash, 4);

  const topClients = [...latest.rows]
    .sort((a, b) => (b.portfolioValue ?? 0) - (a.portfolioValue ?? 0))
    .slice(0, TOP_CLIENTS)
    .map((r) => ({
      clientId: r.clientId,
      name: r.name,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      portfolioValue: r.portfolioValue ?? 0,
      systemCash: r.systemCash ?? 0,
    }));

  // Ledger + DSM/QERI live in different stores. A Postgres/index failure must not
  // fail the SQL snapshot KPIs (that is what Clients uses MSSQL for).
  const [ledger, dsm, qeri] = await Promise.all([
    listExtClients(resolvedAsOf).catch((err) => {
      console.error("[sql-dashboard] listExtClients failed; snapshot KPIs still returned", err);
      return [] as Awaited<ReturnType<typeof listExtClients>>;
    }),
    loadIndexSpark("DSM").catch((err) => {
      console.error("[sql-dashboard] DSM spark failed", err);
      return null;
    }),
    loadIndexSpark("QERI").catch((err) => {
      console.error("[sql-dashboard] QERI spark failed", err);
      return null;
    }),
  ]);

  const shareTxRows = ledger.reduce((s, r) => s + Number(r.shareCount || 0), 0);
  const cashTxRows = ledger.reduce((s, r) => s + Number(r.cashCount || 0), 0);
  const clientsWithShares = ledger.filter((r) => r.shareCount > 0).length;

  return {
    source: "sql" as const,
    configured: true,
    asOf: resolvedAsOf,
    qscDates,
    metrics: {
      totalPortfolioValue: latest.portfolioValue,
      totalSystemCash: latest.systemCash,
      /** Display only: QSC PortfolioValue + SystemCash. Official NAV definition is still client-confirmed. */
      totalNavDisplay: roundMoney(latest.portfolioValue + latest.systemCash, 4),
      activeClients: latest.clientCount,
      avgPortfolioSize:
        latest.clientCount > 0
          ? roundMoney(latest.portfolioValue / latest.clientCount, 4)
          : 0,
      clientsWithShares: latest.withEquity || clientsWithShares,
      clientsCashOnly: latest.cashOnly,
      ledgerClients: ledger.length,
      shareTxRows,
      cashTxRows,
      pvDelta,
      pvDeltaPct,
      cashDelta,
    },
    trajectory,
    topClients,
    mix: {
      equity: latest.portfolioValue,
      cash: latest.systemCash,
    },
    indices: { dsm, qeri },
  };
}
