import { db, schema } from "../db/connection.js";
import { eq, and, desc, lte, asc } from "drizzle-orm";
import { qtyDelta, type StockTxType } from "../lib/tx-type.js";
import { adjustActiveBandHwm } from "./fee-engine.js";

const tn = (v: unknown) => Number(v ?? 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type MarketDayQuote = {
  sourceDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  /** Alias of close for callers that only need a default fill price. */
  price: number;
};

export async function findClosingPriceOnDate(stockId: string, date: string): Promise<MarketDayQuote | null> {
  const rows = await db
    .select({
      date: schema.stockPrices.date,
      price: schema.stockPrices.price,
      openPrice: schema.stockPrices.openPrice,
      highPrice: schema.stockPrices.highPrice,
      lowPrice: schema.stockPrices.lowPrice,
      closePrice: schema.stockPrices.closePrice,
    })
    .from(schema.stockPrices)
    .where(and(eq(schema.stockPrices.stockId, stockId), lte(schema.stockPrices.date, date)))
    .orderBy(desc(schema.stockPrices.date))
    .limit(1);
  if (!rows[0]) return null;
  const close = tn(rows[0].closePrice ?? rows[0].price);
  if (!Number.isFinite(close) || close <= 0) return null;
  const open = rows[0].openPrice != null ? tn(rows[0].openPrice) : null;
  const high = rows[0].highPrice != null ? tn(rows[0].highPrice) : null;
  const low = rows[0].lowPrice != null ? tn(rows[0].lowPrice) : null;
  return {
    sourceDate: String(rows[0].date).slice(0, 10),
    open: open != null && Number.isFinite(open) ? open : null,
    high: high != null && Number.isFinite(high) ? high : null,
    low: low != null && Number.isFinite(low) ? low : null,
    close,
    price: close,
  };
}

/**
 * Inclusive low/high band for trade price validation.
 * Returns null when day high/low are missing — no range validation in that case.
 */
export function dayPriceBand(quote: MarketDayQuote): { low: number; high: number } | null {
  const hasLow = quote.low != null && Number.isFinite(quote.low) && quote.low > 0;
  const hasHigh = quote.high != null && Number.isFinite(quote.high) && quote.high > 0;
  if (!hasLow || !hasHigh) return null;
  return {
    low: Math.min(quote.low!, quote.high!, quote.close),
    high: Math.max(quote.low!, quote.high!, quote.close),
  };
}

export async function heldQuantityAsOf(portfolioId: string, stockId: string, asOf: Date): Promise<number> {
  const rows = await db
    .select({
      type: schema.transactions.type,
      quantity: schema.transactions.quantity,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.portfolioId, portfolioId),
      eq(schema.transactions.stockId, stockId),
      lte(schema.transactions.timestamp, asOf),
    ))
    .orderBy(asc(schema.transactions.timestamp));

  let qty = 0;
  for (const r of rows) {
    qty = round4(qty + qtyDelta(r.type, tn(r.quantity)));
  }
  return round4(qty);
}

export type TradeInput = {
  portfolioId: string;
  stockId: string;
  type: StockTxType;
  quantity: number;
  /** If omitted (and not forceClosing), trade fails unless forceClosingPrice fills from close. */
  price?: number | null;
  timestamp: Date;
  notes?: string | null;
  createdBy?: string | null;
  /** Links the stock tx to a rebalance when executing proposed trades. */
  rebalanceId?: string | null;
  /** When true, ignore caller price and use market close. */
  forceClosingPrice?: boolean;
  /** When true, do not reject fills outside that day's QSE high/low (bulk test / corrupted dates). */
  skipPriceRange?: boolean;
};

export type TradeResult = {
  transaction: typeof schema.transactions.$inferSelect;
  cashTransaction: typeof schema.cashTransactions.$inferSelect | null;
  cashBalanceAfter: number;
  tradeAmount: number;
  priceUsed: number;
  priceSourceDate: string | null;
  dayLow: number | null;
  dayHigh: number | null;
};

/**
 * Create a stock trade, debit/credit cash ledger, update portfolio cash,
 * and store remaining cash balance on the transaction.
 */
export async function executeStockTrade(input: TradeInput): Promise<TradeResult> {
  if (input.type === "CLIENT_TRANSFER") return executeClientTransfer(input);

  const qty = tn(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error("Quantity must be positive"), { status: 400 });
  if (input.type !== "BUY" && input.type !== "SELL") {
    throw Object.assign(new Error("type must be BUY, SELL, or CLIENT_TRANSFER"), { status: 400 });
  }

  const tradeDate = input.timestamp.toISOString().slice(0, 10);
  const market = await findClosingPriceOnDate(input.stockId, tradeDate);
  const hasExplicitPrice =
    !input.forceClosingPrice &&
    input.price != null &&
    Number.isFinite(Number(input.price)) &&
    Number(input.price) > 0;

  // Closing-price fill still needs market data; sheet/manual fill prices do not.
  if (!hasExplicitPrice && !market) {
    throw Object.assign(new Error(`No market price for this stock on/before ${tradeDate}`), { status: 400 });
  }

  const priceUsed = hasExplicitPrice ? tn(input.price) : market!.close;
  const band = market ? dayPriceBand(market) : null;

  // Only validate against low–high when both exist for the market day
  if (band && !input.skipPriceRange) {
    const eps = 0.0001;
    if (priceUsed + eps < band.low || priceUsed - eps > band.high) {
      throw Object.assign(
        new Error(
          `Trade price ${priceUsed} must be between day low ${band.low} and day high ${band.high} (${market!.sourceDate})`,
        ),
        { status: 400, code: "PRICE_OUT_OF_RANGE" },
      );
    }
  }

  const priceSourceDate = market?.sourceDate ?? null;
  const tradeAmount = round4(qty * priceUsed);

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, input.portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });

  const cashBefore = tn(portfolio.cashBalance);
  if (input.type === "BUY") {
    if (cashBefore + 0.0001 < tradeAmount) {
      throw Object.assign(
        new Error(`Insufficient cash. Need ${tradeAmount.toFixed(2)} QAR, available ${cashBefore.toFixed(2)} QAR`),
        { status: 400, code: "INSUFFICIENT_CASH" },
      );
    }
  } else {
    const held = await heldQuantityAsOf(input.portfolioId, input.stockId, input.timestamp);
    if (held + 0.0001 < qty) {
      throw Object.assign(
        new Error(`Insufficient shares. Trying to sell ${qty}, held ${held}`),
        { status: 400, code: "INSUFFICIENT_SHARES" },
      );
    }
  }

  const cashAfter = round4(input.type === "BUY" ? cashBefore - tradeAmount : cashBefore + tradeAmount);
  const cashType = input.type === "BUY" ? "trade_buy" : "trade_sell";

  const [stock] = await db.select({ ticker: schema.stocks.ticker }).from(schema.stocks).where(eq(schema.stocks.id, input.stockId)).limit(1);
  const ticker = stock?.ticker || "STOCK";

  const [created] = await db.insert(schema.transactions).values({
    portfolioId: input.portfolioId,
    stockId: input.stockId,
    type: input.type,
    quantity: String(qty),
    price: String(priceUsed),
    timestamp: input.timestamp,
    notes: input.notes || null,
    cashBalanceAfter: String(cashAfter),
    rebalanceId: input.rebalanceId || null,
  }).returning();

  const [cashTx] = await db.insert(schema.cashTransactions).values({
    portfolioId: input.portfolioId,
    type: cashType as "trade_buy" | "trade_sell",
    amount: String(tradeAmount),
    tradeDate,
    reference: `TX:${created.id.slice(0, 8)}`,
    notes: `${input.type} ${qty} ${ticker} @ ${priceUsed}` + (!hasExplicitPrice && priceSourceDate && priceSourceDate !== tradeDate ? ` (close ${priceSourceDate})` : ""),
    createdBy: input.createdBy || null,
    stockTransactionId: created.id,
  }).returning();

  await db.update(schema.portfolios).set({
    cashBalance: String(cashAfter),
    updatedAt: new Date(),
  }).where(eq(schema.portfolios.id, input.portfolioId));

  return {
    transaction: created,
    cashTransaction: cashTx,
    cashBalanceAfter: cashAfter,
    tradeAmount,
    priceUsed,
    priceSourceDate,
    dayLow: band?.low ?? null,
    dayHigh: band?.high ?? null,
  };
}

/**
 * In-kind holding booking: ticker + qty + date + cost price.
 * Does not move cash. Cost is used for average buy price. HWM rises by qty × price
 * so the transferred shares are treated as contributed capital, not performance.
 */
export async function executeClientTransfer(input: TradeInput): Promise<TradeResult> {
  const qty = tn(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error("Quantity must be positive"), { status: 400 });

  const tradeDate = input.timestamp.toISOString().slice(0, 10);
  const market = await findClosingPriceOnDate(input.stockId, tradeDate);
  const hasExplicitPrice =
    !input.forceClosingPrice &&
    input.price != null &&
    Number.isFinite(Number(input.price)) &&
    Number(input.price) > 0;

  if (!hasExplicitPrice && !market) {
    throw Object.assign(new Error(`No market price for this stock on/before ${tradeDate}`), { status: 400 });
  }

  const priceUsed = hasExplicitPrice ? tn(input.price) : market!.close;
  const tradeAmount = round4(qty * priceUsed);

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, input.portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });

  const cashAfter = round4(tn(portfolio.cashBalance));
  const notes = input.notes || `Client transfer in ${qty} @ ${priceUsed} (no cash impact)`;

  const [created] = await db.insert(schema.transactions).values({
    portfolioId: input.portfolioId,
    stockId: input.stockId,
    type: "CLIENT_TRANSFER",
    quantity: String(qty),
    price: String(priceUsed),
    timestamp: input.timestamp,
    notes,
    cashBalanceAfter: String(cashAfter),
  }).returning();

  if (portfolio.customerId) {
    await adjustActiveBandHwm(portfolio.customerId, tradeAmount, tradeDate);
  }

  return {
    transaction: created,
    cashTransaction: null,
    cashBalanceAfter: cashAfter,
    tradeAmount,
    priceUsed,
    priceSourceDate: market?.sourceDate ?? null,
    dayLow: market ? dayPriceBand(market)?.low ?? null : null,
    dayHigh: market ? dayPriceBand(market)?.high ?? null : null,
  };
}

export async function reverseStockTradeCash(transactionId: string): Promise<{ reversed: boolean; cashBalanceAfter?: number }> {
  const [tx] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, transactionId)).limit(1);
  if (!tx) return { reversed: false };

  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, tx.portfolioId)).limit(1);
  if (!portfolio) {
    await db.delete(schema.fiLots).where(eq(schema.fiLots.buyTxId, transactionId));
    await db.delete(schema.transactions).where(eq(schema.transactions.id, transactionId));
    return { reversed: true };
  }

  if (tx.type === "CLIENT_TRANSFER") {
    const amt = round4(tn(tx.quantity) * tn(tx.price));
    await db.delete(schema.fiLots).where(eq(schema.fiLots.buyTxId, transactionId));
    await db.delete(schema.transactions).where(eq(schema.transactions.id, transactionId));
    if (portfolio.customerId) {
      await adjustActiveBandHwm(portfolio.customerId, -amt, tx.timestamp.toISOString().slice(0, 10));
    }
    return { reversed: true, cashBalanceAfter: tn(portfolio.cashBalance) };
  }

  const cashRows = await db.select().from(schema.cashTransactions)
    .where(eq(schema.cashTransactions.stockTransactionId, transactionId));

  let cash = tn(portfolio.cashBalance);
  for (const c of cashRows) {
    const amt = tn(c.amount);
    // Reverse: trade_buy was a debit → credit back; trade_sell was a credit → debit back
    if (c.type === "trade_buy") cash = round4(cash + amt);
    else if (c.type === "trade_sell") cash = round4(cash - amt);
    await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.id, c.id));
  }

  // Legacy trades without cash link: reverse from stock tx itself
  if (cashRows.length === 0 && tx.cashBalanceAfter != null) {
    const amt = round4(tn(tx.quantity) * tn(tx.price));
    if (tx.type === "BUY") cash = round4(cash + amt);
    else cash = round4(cash - amt);
  }

  await db.delete(schema.fiLots).where(eq(schema.fiLots.buyTxId, transactionId));

  await db.update(schema.portfolios).set({
    cashBalance: String(cash),
    updatedAt: new Date(),
  }).where(eq(schema.portfolios.id, tx.portfolioId));

  await db.delete(schema.transactions).where(eq(schema.transactions.id, transactionId));
  return { reversed: true, cashBalanceAfter: cash };
}
