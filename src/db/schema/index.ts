import { pgTable, uuid, varchar, text, date, numeric, timestamp, pgEnum, uniqueIndex, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const transactionTypeEnum = pgEnum("transaction_type", ["BUY", "SELL", "CLIENT_TRANSFER"]);
export const corporateActionTypeEnum = pgEnum("corporate_action_type", [
  "BONUS", "STOCK_SPLIT", "DIVIDEND", "RIGHTS", "CAPITAL_REDUCTION", "MERGER_NAME_CHANGE",
]);
export const clientTypeEnum = pgEnum("client_type", ["individual", "company"]);
export const genderEnum = pgEnum("gender", ["male", "female"]);

/** Per-user display settings (theme, data density, chrome). Extend freely; consumers should tolerate unknown/missing keys. */
export type UiPreferences = {
  theme?: "dark" | "light" | "system";
  density?: "compact" | "default" | "comfortable";
  headerPin?: "sticky" | "flow";
  sidebarMode?: "auto" | "expanded" | "collapsed";
  palette?: string;
  accent?: string;
  showClock?: boolean;
};

export const admins = pgTable("admins", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  displayName: varchar("display_name", { length: 200 }),
  role: varchar("role", { length: 40 }).notNull().default("admin"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  uiPreferences: jsonb("ui_preferences").$type<UiPreferences>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const indices = pgTable("indices", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const indexDataPoints = pgTable("index_data_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  indexId: uuid("index_id").notNull().references(() => indices.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  /** Close / current index level (CI_CURRENT_INDEX). */
  value: numeric("value", { precision: 15, scale: 4 }).notNull(),
  openValue: numeric("open_value", { precision: 15, scale: 4 }),
  highValue: numeric("high_value", { precision: 15, scale: 4 }),
  lowValue: numeric("low_value", { precision: 15, scale: 4 }),
}, (table) => [
  uniqueIndex("idx_index_date").on(table.indexId, table.date),
]);

export const instrumentTypeEnum = pgEnum("instrument_type", [
  "equity", "gov_bond", "t_bill", "sukuk", "other_debt",
]);

export const stocks = pgTable("stocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticker: varchar("ticker", { length: 20 }).notNull().unique(),
  companyName: varchar("company_name", { length: 300 }).notNull(),
  sector: varchar("sector", { length: 100 }).notNull(),
  instrumentType: instrumentTypeEnum("instrument_type").notNull().default("equity"),
  shariahGroup: varchar("shariah_group", { length: 20 }),
  isQeriMember: boolean("is_qeri_member").notNull().default(false),
  isDsmMember: boolean("is_dsm_member").notNull().default(false),
  avgDailyTradedValue: numeric("avg_daily_traded_value", { precision: 18, scale: 4 }),
  isIlliquid: boolean("is_illiquid").notNull().default(false),
  regulatoryStatus: varchar("regulatory_status", { length: 20 }).notNull().default("clear"),
  regulatoryNotes: text("regulatory_notes"),
  isTradable: boolean("is_tradable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const stockPrices = pgTable("stock_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  /** Primary close used by valuation / charts (from PR_C_PRICE or PR_SHARE_PRICE). */
  price: numeric("price", { precision: 15, scale: 4 }).notNull(),
  /** Raw market-feed history fields (stored only; not used in trading logic). */
  sharePrice: numeric("share_price", { precision: 15, scale: 4 }),
  ask: numeric("ask", { precision: 15, scale: 4 }),
  offer: numeric("offer", { precision: 15, scale: 4 }),
  orderNum: numeric("order_num", { precision: 18, scale: 0 }),
  volume: numeric("volume", { precision: 18, scale: 0 }),
  month: varchar("month", { length: 20 }),
  openPrice: numeric("open_price", { precision: 15, scale: 4 }),
  highPrice: numeric("high_price", { precision: 15, scale: 4 }),
  lowPrice: numeric("low_price", { precision: 15, scale: 4 }),
  closePrice: numeric("close_price", { precision: 15, scale: 4 }),
}, (table) => [
  uniqueIndex("idx_stock_date").on(table.stockId, table.date),
]);

export const corporateActions = pgTable("corporate_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
  actionDate: date("action_date").notNull(),
  actionType: corporateActionTypeEnum("action_type").notNull(),
  ratio: numeric("ratio", { precision: 15, scale: 8 }),
  cashAmount: numeric("cash_amount", { precision: 15, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_corp_action_stock_date_type").on(table.stockId, table.actionDate, table.actionType),
]);

export const adjustedPrices = pgTable("adjusted_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
  tradeDate: date("trade_date").notNull(),
  rawClose: numeric("raw_close", { precision: 15, scale: 4 }).notNull(),
  adjustedClose: numeric("adjusted_close", { precision: 15, scale: 4 }).notNull(),
  adjustmentFactor: numeric("adjustment_factor", { precision: 15, scale: 8 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_adj_price_stock_date").on(table.stockId, table.tradeDate),
]);

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 300 }).notNull(),
  email: varchar("email", { length: 300 }).notNull().unique(),
  joinDate: date("join_date").notNull(),
  accountNumber: varchar("account_number", { length: 50 }),
  portfolioManagerId: uuid("portfolio_manager_id").references(() => admins.id, { onDelete: "set null" }),
  notes: text("notes"),
  // KYC / client profile fields
  clientType: clientTypeEnum("client_type").notNull().default("individual"),
  title: varchar("title", { length: 20 }),
  gender: genderEnum("gender"),
  birthdate: date("birthdate"),
  nationality: varchar("nationality", { length: 120 }),
  mobileNumber: varchar("mobile_number", { length: 30 }),
  city: varchar("city", { length: 120 }),
  country: varchar("country", { length: 120 }),
  idNumber: varchar("id_number", { length: 60 }),
  idValidity: date("id_validity"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const portfolios = pgTable("portfolios", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }).unique(),
  name: varchar("name", { length: 300 }).notNull(),
  benchmarkIndexId: uuid("benchmark_index_id").references(() => indices.id, { onDelete: "set null" }),
  modelPortfolioId: uuid("model_portfolio_id"),
  baseCurrency: varchar("base_currency", { length: 3 }).notNull().default("QAR"),
  cashBalance: numeric("cash_balance", { precision: 18, scale: 4 }).notNull().default("0"),
  inceptionDate: date("inception_date"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/** Per-portfolio effects of a corporate action (share qty / cash). Reversed + deleted when CA is deleted. */
export const corporateActionApplications = pgTable("corporate_action_applications", {
  id: uuid("id").defaultRandom().primaryKey(),
  corporateActionId: uuid("corporate_action_id").notNull().references(() => corporateActions.id, { onDelete: "cascade" }),
  portfolioId: uuid("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
  actionDate: date("action_date").notNull(),
  actionType: corporateActionTypeEnum("action_type").notNull(),
  qtyBefore: numeric("qty_before", { precision: 18, scale: 4 }).notNull(),
  qtyAfter: numeric("qty_after", { precision: 18, scale: 4 }).notNull(),
  qtyDelta: numeric("qty_delta", { precision: 18, scale: 4 }).notNull().default("0"),
  costBefore: numeric("cost_before", { precision: 18, scale: 4 }).notNull(),
  costAfter: numeric("cost_after", { precision: 18, scale: 4 }).notNull(),
  cashAmount: numeric("cash_amount", { precision: 18, scale: 4 }).notNull().default("0"),
  cashTransactionId: uuid("cash_transaction_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_ca_app_unique").on(table.corporateActionId, table.portfolioId),
  uniqueIndex("idx_ca_app_client_date_type_amount").on(
    table.portfolioId,
    table.stockId,
    table.actionDate,
    table.actionType,
    table.cashAmount,
    table.qtyDelta,
  ),
  index("idx_ca_app_portfolio_stock_date").on(table.portfolioId, table.stockId, table.actionDate),
]);

export const transactions = pgTable("transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
  type: transactionTypeEnum("type").notNull(),
  quantity: numeric("quantity", { precision: 15, scale: 4 }).notNull(),
  price: numeric("price", { precision: 20, scale: 10 }).notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  rebalanceId: uuid("rebalance_id"),
  commission: numeric("commission", { precision: 18, scale: 4 }),
  notes: text("notes"),
  /** Portfolio cash balance immediately after this trade settled. */
  cashBalanceAfter: numeric("cash_balance_after", { precision: 18, scale: 4 }),
  /** Broker-sheet import batch that inserted this row (nullable for manual / template txs). */
  sourceImportId: uuid("source_import_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_tx_source_import").on(table.sourceImportId),
]);

export const indicesRelations = relations(indices, ({ many }) => ({
  dataPoints: many(indexDataPoints),
  portfolios: many(portfolios),
}));

export const indexDataPointsRelations = relations(indexDataPoints, ({ one }) => ({
  index: one(indices, { fields: [indexDataPoints.indexId], references: [indices.id] }),
}));

export const stocksRelations = relations(stocks, ({ many }) => ({
  prices: many(stockPrices),
  transactions: many(transactions),
  corporateActions: many(corporateActions),
  adjustedPrices: many(adjustedPrices),
}));

export const stockPricesRelations = relations(stockPrices, ({ one }) => ({
  stock: one(stocks, { fields: [stockPrices.stockId], references: [stocks.id] }),
}));

export const corporateActionsRelations = relations(corporateActions, ({ one, many }) => ({
  stock: one(stocks, { fields: [corporateActions.stockId], references: [stocks.id] }),
  applications: many(corporateActionApplications),
}));

export const corporateActionApplicationsRelations = relations(corporateActionApplications, ({ one }) => ({
  corporateAction: one(corporateActions, {
    fields: [corporateActionApplications.corporateActionId],
    references: [corporateActions.id],
  }),
  portfolio: one(portfolios, {
    fields: [corporateActionApplications.portfolioId],
    references: [portfolios.id],
  }),
  stock: one(stocks, {
    fields: [corporateActionApplications.stockId],
    references: [stocks.id],
  }),
}));

export const adjustedPricesRelations = relations(adjustedPrices, ({ one }) => ({
  stock: one(stocks, { fields: [adjustedPrices.stockId], references: [stocks.id] }),
}));

export const customersRelations = relations(customers, ({ one }) => ({
  portfolio: one(portfolios, { fields: [customers.id], references: [portfolios.customerId] }),
}));

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  customer: one(customers, { fields: [portfolios.customerId], references: [customers.id] }),
  benchmarkIndex: one(indices, { fields: [portfolios.benchmarkIndexId], references: [indices.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  portfolio: one(portfolios, { fields: [transactions.portfolioId], references: [portfolios.id] }),
  stock: one(stocks, { fields: [transactions.stockId], references: [stocks.id] }),
}));

export * from "./sector-intel.js";
export * from "./phase1.js";
export * from "./fixed-income.js";
export * from "./phase2.js";
export * from "./phase3.js";
export * from "./phase4.js";
export * from "./snapshots.js";
