import {
  pgTable, uuid, varchar, text, date, numeric, timestamp, boolean,
  pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const couponFrequencyEnum = pgEnum("coupon_frequency", [
  "zero", "annual", "semi_annual", "quarterly",
]);
export const dayCountEnum = pgEnum("day_count", [
  "ACT_PERIOD", "ACT_365", "ACT_360", "ACT_ACT", "30_360",
]);
export const fiLotStatusEnum = pgEnum("fi_lot_status", ["open", "sold", "matured"]);
export const couponScheduleStatusEnum = pgEnum("coupon_schedule_status", [
  "scheduled", "paid", "skipped",
]);

/** Terms for a QSE-listed debt instrument (1:1 with stocks). */
export const fiInstruments = pgTable("fi_instruments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().unique(),
  facePar: numeric("face_par", { precision: 18, scale: 4 }).notNull().default("100"),
  couponRate: numeric("coupon_rate", { precision: 12, scale: 8 }).notNull().default("0"),
  couponFrequency: couponFrequencyEnum("coupon_frequency").notNull().default("semi_annual"),
  /** ACT_PERIOD = coupon ÷ actual calendar days in that coupon window (recommended). */
  dayCount: dayCountEnum("day_count").notNull().default("ACT_PERIOD"),
  issueDate: date("issue_date"),
  maturityDate: date("maturity_date"),
  priceConvention: varchar("price_convention", { length: 32 }).notNull().default("percent_of_par"),
  shariahNotes: text("shariah_notes"),
  termsComplete: boolean("terms_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const fiCouponSchedule = pgTable("fi_coupon_schedule", {
  id: uuid("id").defaultRandom().primaryKey(),
  fiInstrumentId: uuid("fi_instrument_id").notNull().references(() => fiInstruments.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payDate: date("pay_date").notNull(),
  /** Full coupon cash for 100 face for this period (e.g. rate/2 * 100 for semi). */
  couponPerPar: numeric("coupon_per_par", { precision: 18, scale: 8 }).notNull(),
  /** Actual calendar days in [periodStart, periodEnd). */
  actualDays: numeric("actual_days", { precision: 10, scale: 0 }).notNull(),
  /** couponPerPar / actualDays — daily accrual per 100 face. */
  dailyAccrualPerPar: numeric("daily_accrual_per_par", { precision: 18, scale: 10 }).notNull(),
  status: couponScheduleStatusEnum("status").notNull().default("scheduled"),
}, (t) => [
  uniqueIndex("idx_fi_coupon_unique").on(t.fiInstrumentId, t.periodStart, t.payDate),
  index("idx_fi_coupon_pay").on(t.fiInstrumentId, t.payDate),
]);

export const fiLots = pgTable("fi_lots", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  stockId: uuid("stock_id").notNull(),
  fiInstrumentId: uuid("fi_instrument_id").notNull().references(() => fiInstruments.id, { onDelete: "restrict" }),
  buyTxId: uuid("buy_tx_id"),
  sellTxId: uuid("sell_tx_id"),
  /** Face amount in currency units (quantity × facePar). */
  faceAmount: numeric("face_amount", { precision: 18, scale: 4 }).notNull(),
  /** Number of units purchased (transactions.quantity). */
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  purchaseClean: numeric("purchase_clean", { precision: 15, scale: 6 }).notNull(),
  purchaseDirty: numeric("purchase_dirty", { precision: 15, scale: 6 }).notNull(),
  purchaseAccruedPerPar: numeric("purchase_accrued_per_par", { precision: 18, scale: 10 }).notNull().default("0"),
  settlementDate: date("settlement_date").notNull(),
  maturityDate: date("maturity_date").notNull(),
  status: fiLotStatusEnum("status").notNull().default("open"),
  closedDate: date("closed_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fi_lots_portfolio").on(t.portfolioId, t.status),
  index("idx_fi_lots_stock").on(t.stockId),
]);

export const fiDailyPnl = pgTable("fi_daily_pnl", {
  id: uuid("id").defaultRandom().primaryKey(),
  lotId: uuid("lot_id").notNull().references(() => fiLots.id, { onDelete: "cascade" }),
  portfolioId: uuid("portfolio_id").notNull(),
  stockId: uuid("stock_id").notNull(),
  asOfDate: date("as_of_date").notNull(),
  periodActualDays: numeric("period_actual_days", { precision: 10, scale: 0 }),
  couponAccrual: numeric("coupon_accrual", { precision: 18, scale: 8 }).notNull().default("0"),
  amortization: numeric("amortization", { precision: 18, scale: 8 }).notNull().default("0"),
  bookPnl: numeric("book_pnl", { precision: 18, scale: 8 }).notNull().default("0"),
  bookValue: numeric("book_value", { precision: 18, scale: 8 }).notNull(),
  accruedInterest: numeric("accrued_interest", { precision: 18, scale: 8 }).notNull().default("0"),
  cleanPrice: numeric("clean_price", { precision: 15, scale: 6 }),
  dirtyPrice: numeric("dirty_price", { precision: 15, scale: 6 }),
  marketValue: numeric("market_value", { precision: 18, scale: 8 }),
  mtmPnl: numeric("mtm_pnl", { precision: 18, scale: 8 }).notNull().default("0"),
  couponCash: numeric("coupon_cash", { precision: 18, scale: 8 }).notNull().default("0"),
  priceStale: boolean("price_stale").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fi_daily_lot_date").on(t.lotId, t.asOfDate),
  index("idx_fi_daily_portfolio_date").on(t.portfolioId, t.asOfDate),
]);
