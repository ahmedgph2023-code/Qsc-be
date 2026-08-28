import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "../../db/connection.js";
import { buildCouponSchedule, accruedPerParThrough } from "./schedule.js";
import { generateDailyBookPnl } from "./accrual.js";
import { attachMtm } from "./mtm.js";
import { minDate } from "./day-count.js";

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function rebuildInstrumentSchedule(fiInstrumentId: string) {
  const [inst] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.id, fiInstrumentId));
  if (!inst) throw new Error("FI instrument not found");
  if (!inst.issueDate || !inst.maturityDate) throw new Error("issueDate and maturityDate required");

  const periods = buildCouponSchedule({
    issueDate: inst.issueDate,
    maturityDate: inst.maturityDate,
    couponRate: num(inst.couponRate),
    couponFrequency: inst.couponFrequency,
    facePar: num(inst.facePar, 100),
  });

  await db.delete(schema.fiCouponSchedule).where(eq(schema.fiCouponSchedule.fiInstrumentId, fiInstrumentId));
  if (periods.length) {
    await db.insert(schema.fiCouponSchedule).values(periods.map((p) => ({
      fiInstrumentId,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      payDate: p.payDate,
      couponPerPar: String(p.couponPerPar),
      actualDays: String(p.actualDays),
      dailyAccrualPerPar: String(p.dailyAccrualPerPar),
      status: "scheduled" as const,
    })));
  }

  const complete = !!(inst.maturityDate && inst.issueDate);
  await db.update(schema.fiInstruments).set({
    termsComplete: complete,
    updatedAt: new Date(),
  }).where(eq(schema.fiInstruments.id, fiInstrumentId));

  return periods;
}

export async function rebuildLotDailyPnl(lotId: string, endDate?: string) {
  const [lot] = await db.select().from(schema.fiLots).where(eq(schema.fiLots.id, lotId));
  if (!lot) throw new Error("Lot not found");
  const [inst] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.id, lot.fiInstrumentId));
  if (!inst?.issueDate || !inst.maturityDate) throw new Error("Instrument terms incomplete");

  const sched = await db.select().from(schema.fiCouponSchedule)
    .where(eq(schema.fiCouponSchedule.fiInstrumentId, inst.id))
    .orderBy(asc(schema.fiCouponSchedule.periodStart));

  let periods = sched.map((p) => ({
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    payDate: p.payDate,
    couponPerPar: num(p.couponPerPar),
    actualDays: num(p.actualDays),
    dailyAccrualPerPar: num(p.dailyAccrualPerPar),
  }));
  if (!periods.length && inst.couponFrequency !== "zero") {
    periods = await rebuildInstrumentSchedule(inst.id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const close = lot.closedDate || inst.maturityDate;
  const until = minDate(endDate || today, close);

  const bookRows = generateDailyBookPnl({
    faceAmount: num(lot.faceAmount),
    facePar: num(inst.facePar, 100),
    couponRate: num(inst.couponRate),
    couponFrequency: inst.couponFrequency,
    issueDate: inst.issueDate,
    maturityDate: inst.maturityDate,
    settlementDate: lot.settlementDate,
    purchaseDirty: num(lot.purchaseDirty),
    purchaseAccruedPerPar: num(lot.purchaseAccruedPerPar),
    endDate: until,
    periods,
  });

  const prices = await db.select({
    date: schema.stockPrices.date,
    price: schema.stockPrices.price,
  }).from(schema.stockPrices)
    .where(and(
      eq(schema.stockPrices.stockId, lot.stockId),
      gte(schema.stockPrices.date, lot.settlementDate),
      lte(schema.stockPrices.date, until),
    ))
    .orderBy(asc(schema.stockPrices.date));

  const mtm = attachMtm({
    bookRows,
    faceAmount: num(lot.faceAmount),
    facePar: num(inst.facePar, 100),
    prices: prices.map((p) => ({ date: p.date, price: num(p.price) })),
  });
  const mtmByDate = new Map(mtm.map((m) => [m.asOfDate, m]));

  await db.delete(schema.fiDailyPnl).where(and(
    eq(schema.fiDailyPnl.lotId, lotId),
    lte(schema.fiDailyPnl.asOfDate, until),
  ));

  const chunk = 500;
  for (let i = 0; i < bookRows.length; i += chunk) {
    const slice = bookRows.slice(i, i + chunk);
    await db.insert(schema.fiDailyPnl).values(slice.map((r) => {
      const m = mtmByDate.get(r.asOfDate);
      return {
        lotId,
        portfolioId: lot.portfolioId,
        stockId: lot.stockId,
        asOfDate: r.asOfDate,
        periodActualDays: r.periodActualDays != null ? String(r.periodActualDays) : null,
        couponAccrual: String(r.couponAccrual),
        amortization: String(r.amortization),
        bookPnl: String(r.bookPnl),
        bookValue: String(r.bookValue),
        accruedInterest: String(r.accruedInterest),
        cleanPrice: m?.cleanPrice != null ? String(m.cleanPrice) : null,
        dirtyPrice: m?.dirtyPrice != null ? String(m.dirtyPrice) : null,
        marketValue: m?.marketValue != null ? String(m.marketValue) : null,
        mtmPnl: String(m?.mtmPnl ?? 0),
        couponCash: String(r.couponCash),
        priceStale: m?.priceStale ?? true,
      };
    }));
  }

  return { rows: bookRows.length, from: lot.settlementDate, to: until };
}

export async function rebuildPortfolioDailyPnl(portfolioId: string, endDate?: string) {
  const lots = await db.select().from(schema.fiLots).where(eq(schema.fiLots.portfolioId, portfolioId));
  const results = [];
  for (const lot of lots) {
    if (!lot.fiInstrumentId) continue;
    try {
      results.push({ lotId: lot.id, ...(await rebuildLotDailyPnl(lot.id, endDate)) });
    } catch (e: any) {
      results.push({ lotId: lot.id, error: e.message });
    }
  }
  return results;
}

export async function createLotFromBuyTransaction(txId: string) {
  const [tx] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, txId));
  if (!tx || tx.type !== "BUY") throw new Error("BUY transaction required");

  const [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.id, tx.stockId));
  if (!stock || stock.instrumentType === "equity") throw new Error("Not a fixed-income instrument");

  let [inst] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, tx.stockId));
  if (!inst) throw new Error("FI terms missing — save instrument terms first");
  if (!inst.maturityDate || !inst.issueDate) throw new Error("FI terms incomplete");

  const existing = await db.select().from(schema.fiLots).where(eq(schema.fiLots.buyTxId, txId));
  if (existing.length) return existing[0];

  const qty = num(tx.quantity);
  const facePar = num(inst.facePar, 100);
  const faceAmount = qty * facePar;
  const settlementDate = new Date(tx.timestamp).toISOString().slice(0, 10);
  const purchaseDirty = num(tx.price);

  // Accrued at purchase from schedule
  const periods = await rebuildInstrumentSchedule(inst.id);
  const purchaseAccruedPerPar = accruedPerParThrough(periods, settlementDate, true);
  const purchaseClean = purchaseDirty - purchaseAccruedPerPar;

  const [lot] = await db.insert(schema.fiLots).values({
    portfolioId: tx.portfolioId,
    stockId: tx.stockId,
    fiInstrumentId: inst.id,
    buyTxId: tx.id,
    faceAmount: String(faceAmount),
    quantity: String(qty),
    purchaseClean: String(purchaseClean),
    purchaseDirty: String(purchaseDirty),
    purchaseAccruedPerPar: String(purchaseAccruedPerPar),
    settlementDate,
    maturityDate: inst.maturityDate,
    status: "open",
  }).returning();

  await rebuildLotDailyPnl(lot.id);
  return lot;
}

export async function closeLotOnSell(txId: string) {
  const [tx] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, txId));
  if (!tx || tx.type !== "SELL") throw new Error("SELL transaction required");

  const openLots = await db.select().from(schema.fiLots).where(and(
    eq(schema.fiLots.portfolioId, tx.portfolioId),
    eq(schema.fiLots.stockId, tx.stockId),
    eq(schema.fiLots.status, "open"),
  )).orderBy(asc(schema.fiLots.settlementDate));

  let remaining = num(tx.quantity);
  const sellDate = new Date(tx.timestamp).toISOString().slice(0, 10);
  const closed = [];

  for (const lot of openLots) {
    if (remaining <= 0) break;
    const lotQty = num(lot.quantity);
    const take = Math.min(lotQty, remaining);
    if (take <= 0) continue;

    if (take >= lotQty - 1e-8) {
      await db.update(schema.fiLots).set({
        status: "sold",
        sellTxId: tx.id,
        closedDate: sellDate,
        updatedAt: new Date(),
      }).where(eq(schema.fiLots.id, lot.id));
      await rebuildLotDailyPnl(lot.id, sellDate);
      closed.push(lot.id);
    } else {
      // Partial: shrink lot and rebuild
      const ratio = take / lotQty;
      const newQty = lotQty - take;
      const newFace = num(lot.faceAmount) * (newQty / lotQty);
      await db.update(schema.fiLots).set({
        quantity: String(newQty),
        faceAmount: String(newFace),
        updatedAt: new Date(),
      }).where(eq(schema.fiLots.id, lot.id));
      await rebuildLotDailyPnl(lot.id);
      closed.push(lot.id);
    }
    remaining -= take;
  }
  return closed;
}

export async function upsertFiInstrumentForStock(stockId: string, data: Partial<{
  facePar: number;
  couponRate: number;
  couponFrequency: string;
  dayCount: string;
  issueDate: string | null;
  maturityDate: string | null;
  shariahNotes: string | null;
}>) {
  const [existing] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, stockId));
  const payload = {
    facePar: data.facePar != null ? String(data.facePar) : existing?.facePar ?? "100",
    couponRate: data.couponRate != null ? String(data.couponRate) : existing?.couponRate ?? "0",
    couponFrequency: (data.couponFrequency as any) || existing?.couponFrequency || "semi_annual",
    dayCount: (data.dayCount as any) || existing?.dayCount || "ACT_PERIOD",
    issueDate: data.issueDate !== undefined ? data.issueDate : existing?.issueDate ?? null,
    maturityDate: data.maturityDate !== undefined ? data.maturityDate : existing?.maturityDate ?? null,
    shariahNotes: data.shariahNotes !== undefined ? data.shariahNotes : existing?.shariahNotes ?? null,
    termsComplete: false,
    updatedAt: new Date(),
  };
  payload.termsComplete = !!(payload.issueDate && payload.maturityDate);

  let id: string;
  if (existing) {
    await db.update(schema.fiInstruments).set(payload).where(eq(schema.fiInstruments.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await db.insert(schema.fiInstruments).values({
      stockId,
      ...payload,
    }).returning();
    id = row.id;
  }

  if (payload.termsComplete) await rebuildInstrumentSchedule(id);
  const [inst] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.id, id));
  const schedule = await db.select().from(schema.fiCouponSchedule)
    .where(eq(schema.fiCouponSchedule.fiInstrumentId, id))
    .orderBy(asc(schema.fiCouponSchedule.periodStart));
  return { instrument: inst, schedule };
}
