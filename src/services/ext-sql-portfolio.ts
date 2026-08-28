import {
  applyReplayEvents,
  calendarDaysBetween,
  currentLotOpenedOn,
  excelAnnualizedReturn,
  excelEquityTotals,
  excelHoldingReturn,
  excelReturnContribution,
  lastTxPrice,
  navAllocation,
  type ReplayEvent,
} from "./holdings-replay.js";

export type ExtShareRow = {
  id: number;
  tickerId: string;
  companyName: string;
  invType: string;
  invDate: string;
  buySellFlag: string;
  nin: string;
  clientId: number;
  qty: number;
  avgPrice: number;
  total: number;
  net: number;
  totalComm: number;
  invNo: number | null;
  /** ShareTransactions.CompId — company code on trading-system statements. */
  compId: number | null;
  officeComm: number;
  marketComm: number;
  originalPrice: number;
};

export type ExtCashRow = {
  id: number;
  docCode: string;
  docNo: number | null;
  serNo: number | null;
  nin: string;
  mainObjCode: string | null;
  objCode: number;
  dbAmt: number;
  crAmt: number;
  remarks: string | null;
  eRemarks: string | null;
  docDate: string;
  postDate: string;
  docAmt: number;
  status: string;
};

export type ExtHolding = {
  stockId: string;
  ticker: string;
  companyName: string;
  sector: string;
  quantity: number;
  totalCost: number;
  avgCost: number;
  currentPrice: number;
  currentValue: number;
  gainLossValue: number;
  gainLossPct: number;
  openedOn: string | null;
  holdingDays: number | null;
  excelAnnualizedPct: number | null;
  excelContributionPct: number | null;
  excelWeight: number | null;
  compId: number | null;
};

export type ExtInvestorName = {
  nameEn: string;
  nameAr: string;
};

/** Raw Investors columns. Do not relabel C_ACCOUNT / CL_CLIENT_TYPE until UAT confirms. */
export type ExtInvestorRecord = ExtInvestorName & {
  iDesc: string;
  nin: string;
  cAccount: string | null;
  clientType: string | null;
  email: string | null;
  mobile: string | null;
  mainClientId: string | null;
};

const FLAT = 0.0001;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const roundPct = (n: number) => Math.round(n * 1_000_000) / 10_000;

export function toYmd(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value ?? "").slice(0, 10);
}

export function toNum(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function textOrEmpty(value: unknown): string {
  return String(value ?? "").trim();
}

/** Prefer English name, then Arabic, then description. Never invent a person. */
export function investorDisplayName(
  names: Partial<ExtInvestorName> & { iDesc?: string | null },
  fallback: string,
): string {
  return textOrEmpty(names.nameEn) || textOrEmpty(names.nameAr) || textOrEmpty(names.iDesc) || fallback;
}

export function localizedInvestorName(
  names: Partial<ExtInvestorName>,
  locale: string | undefined,
  fallback: string,
): string {
  const ar = textOrEmpty(names.nameAr);
  const en = textOrEmpty(names.nameEn);
  if (locale === "ar") return ar || en || fallback;
  return en || ar || fallback;
}

/** Observed live: B = buy, S = sell. InvType SP rows have qty with zero value → qty-only (bonus-like). */
export function unitPriceFromShare(row: Pick<ExtShareRow, "qty" | "net" | "total" | "avgPrice">): number {
  if (!(row.qty > 0)) return 0;
  if (row.net) return row.net / row.qty;
  if (row.total) return row.total / row.qty;
  return row.avgPrice;
}

export function shareRowToEvent(row: ExtShareRow): ReplayEvent | null {
  const ticker = row.tickerId.trim();
  if (!ticker || !(row.qty > 0) || !row.invDate) return null;

  const inv = String(row.invType || "").trim().toUpperCase();
  if (inv === "SP") {
    return {
      kind: "ca",
      date: row.invDate,
      sort: row.id,
      stockId: ticker,
      qtyDelta: row.qty,
      costDelta: 0,
    };
  }

  const flag = String(row.buySellFlag || "").trim().toUpperCase();
  if (flag !== "B" && flag !== "S") return null;

  return {
    kind: "tx",
    date: row.invDate,
    sort: row.id,
    stockId: ticker,
    type: flag === "S" ? "SELL" : "BUY",
    quantity: row.qty,
    price: unitPriceFromShare(row),
  };
}

export function eventsFromShares(rows: ExtShareRow[], asOf?: string): ReplayEvent[] {
  const events = rows
    .map(shareRowToEvent)
    .filter((ev): ev is ReplayEvent => ev != null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);
  if (!asOf) return events;
  return events.filter((ev) => ev.date <= asOf);
}

export function cashRowsThrough(rows: ExtCashRow[], asOf?: string): ExtCashRow[] {
  const sorted = [...rows].sort((a, b) => a.postDate.localeCompare(b.postDate) || a.id - b.id);
  if (!asOf) return sorted;
  return sorted.filter((row) => row.postDate <= asOf);
}

export function cashBalance(rows: ExtCashRow[], asOf?: string): number {
  return round4(cashRowsThrough(rows, asOf).reduce((sum, row) => sum + row.crAmt - row.dbAmt, 0));
}

export function realizedFromEvents(events: ReplayEvent[]): number {
  let realized = 0;
  const agg = new Map<string, { quantity: number; totalCost: number }>();
  for (const ev of events) {
    const prev = agg.get(ev.stockId) || { quantity: 0, totalCost: 0 };
    if (ev.kind === "ca") {
      agg.set(ev.stockId, {
        quantity: prev.quantity + ev.qtyDelta,
        totalCost: Math.max(0, prev.totalCost + ev.costDelta),
      });
      continue;
    }
    if (ev.type !== "SELL") {
      agg.set(ev.stockId, {
        quantity: prev.quantity + ev.quantity,
        totalCost: prev.totalCost + ev.quantity * ev.price,
      });
    } else {
      const sellQty = Math.min(ev.quantity, prev.quantity);
      const avgCost = prev.quantity > 0 ? prev.totalCost / prev.quantity : 0;
      realized += sellQty * (ev.price - avgCost);
      agg.set(ev.stockId, {
        quantity: prev.quantity - sellQty,
        totalCost: prev.totalCost - sellQty * avgCost,
      });
    }
  }
  return round4(realized);
}

export function firstActivityDate(shares: ExtShareRow[], cash: ExtCashRow[]): string | null {
  const dates = [
    ...shares.map((r) => r.invDate),
    ...cash.map((r) => r.postDate),
  ].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

export function companyNameFromShare(rows: ExtShareRow[], ticker: string): string {
  const hit = [...rows].reverse().find((r) => r.tickerId.trim() === ticker && r.companyName);
  return hit?.companyName || ticker;
}

export function buildExtHoldings(input: {
  events: ReplayEvent[];
  shares: ExtShareRow[];
  asOf: string;
  cash: number;
  prices: Map<string, number>;
  sectors: Map<string, string>;
  stockIds: Map<string, string>;
  companyNames?: Map<string, string>;
  compIds?: Map<string, number>;
}): ExtHolding[] {
  const positions = applyReplayEvents(input.events);
  const holdings: ExtHolding[] = [];

  for (const [ticker, pos] of positions) {
    if (pos.quantity <= FLAT) continue;
    const avgCost = pos.quantity > 0 ? pos.totalCost / pos.quantity : 0;
    const currentPrice = input.prices.get(ticker) || lastTxPrice(input.events, ticker);
    const currentValue = round4(pos.quantity * currentPrice);
    const totalCost = round4(pos.totalCost);
    const gainLossValue = round4(currentValue - totalCost);
    const openedOn = currentLotOpenedOn(input.events, ticker);
    holdings.push({
      stockId: input.stockIds.get(ticker) || ticker,
      ticker,
      companyName: input.companyNames?.get(ticker) || companyNameFromShare(input.shares, ticker),
      sector: input.sectors.get(ticker) || "Unclassified",
      quantity: round4(pos.quantity),
      totalCost,
      avgCost: round4(avgCost),
      currentPrice: round4(currentPrice),
      currentValue,
      gainLossValue,
      gainLossPct: totalCost > 0 ? roundPct(gainLossValue / totalCost) : 0,
      openedOn,
      holdingDays: openedOn ? calendarDaysBetween(openedOn, input.asOf) : null,
      excelAnnualizedPct: null,
      excelContributionPct: null,
      excelWeight: null,
      compId: input.compIds?.get(ticker)
        ?? input.shares.find((s) => s.tickerId.trim() === ticker && s.compId != null)?.compId
        ?? null,
    });
  }

  holdings.sort((a, b) => b.currentValue - a.currentValue);

  const totalUnrealized = holdings.reduce((s, h) => s + h.gainLossValue, 0);
  const excel = excelEquityTotals(holdings, input.cash);
  for (const h of holdings) {
    const r = excelHoldingReturn(h.currentValue, h.totalCost);
    const ann = r != null && h.holdingDays != null ? excelAnnualizedReturn(r, h.holdingDays) : null;
    const contrib = excelReturnContribution(h.gainLossValue, totalUnrealized);
    h.excelAnnualizedPct = ann == null ? null : roundPct(ann);
    h.excelContributionPct = contrib == null ? null : roundPct(contrib);
    h.excelWeight = excel.equityValue > 0 ? round4(h.currentValue / excel.equityValue) : 0;
  }

  return holdings;
}

export function buildExtWorkbook(holdings: ExtHolding[], cash: number) {
  const excel = excelEquityTotals(holdings, cash);
  return {
    equityValue: excel.equityValue,
    totalCost: excel.totalCost,
    gain: excel.gain,
    growth: excel.growth,
    growthPct: excel.growth == null ? null : roundPct(excel.growth),
  };
}

export function runningCashLedger(rows: ExtCashRow[]) {
  let bal = 0;
  return rows.map((row) => {
    bal = round4(bal + row.crAmt - row.dbAmt);
    return { ...row, balanceAfter: bal };
  });
}

export { navAllocation };
