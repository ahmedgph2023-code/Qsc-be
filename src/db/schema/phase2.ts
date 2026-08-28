import {
  pgTable, uuid, varchar, text, date, numeric, timestamp, integer, pgEnum, index, jsonb,
} from "drizzle-orm/pg-core";

export const orderSideEnum = pgEnum("order_side", ["BUY", "SELL"]);
export const orderStatusEnum = pgEnum("order_status", [
  "draft", "approved", "sent", "partial", "filled", "cancelled", "rejected",
]);
export const allocationMethodEnum = pgEnum("allocation_method", [
  "pro_rata", "model_based", "cash_based", "exception",
]);
export const reportKindEnum = pgEnum("report_kind", ["client_monthly", "aum_monthly", "ic_quarterly"]);
export const reportReleaseStatusEnum = pgEnum("report_release_status", [
  "draft", "pending_recon", "released", "blocked",
]);
export const reconStatusEnum = pgEnum("recon_status", ["open", "explained", "cleared"]);

export const omsBlockGroups = pgTable("oms_block_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull(),
  side: orderSideEnum("side").notNull(),
  allocationMethod: allocationMethodEnum("allocation_method").notNull().default("pro_rata"),
  exceptionReason: text("exception_reason"),
  exceptionApprovedBy: uuid("exception_approved_by"),
  status: varchar("status", { length: 40 }).notNull().default("open"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const omsOrders = pgTable("oms_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  stockId: uuid("stock_id").notNull(),
  side: orderSideEnum("side").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  limitPrice: numeric("limit_price", { precision: 18, scale: 6 }),
  broker: varchar("broker", { length: 120 }),
  reason: text("reason"),
  status: orderStatusEnum("status").notNull().default("draft"),
  rebalanceId: uuid("rebalance_id"),
  blockGroupId: uuid("block_group_id"),
  filledQuantity: numeric("filled_quantity", { precision: 18, scale: 4 }).notNull().default("0"),
  avgFillPrice: numeric("avg_fill_price", { precision: 18, scale: 6 }),
  commission: numeric("commission", { precision: 18, scale: 4 }).notNull().default("0"),
  createdBy: uuid("created_by"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_oms_orders_portfolio").on(t.portfolioId),
  index("idx_oms_orders_status").on(t.status),
  index("idx_oms_orders_block").on(t.blockGroupId),
]);

export const omsFills = pgTable("oms_fills", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  fillQty: numeric("fill_qty", { precision: 18, scale: 4 }).notNull(),
  fillPrice: numeric("fill_price", { precision: 18, scale: 6 }).notNull(),
  commission: numeric("commission", { precision: 18, scale: 4 }).notNull().default("0"),
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
  transactionId: uuid("transaction_id"),
  notes: text("notes"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_oms_fills_order").on(t.orderId)]);

export const reportReleases = pgTable("report_releases", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: reportKindEnum("kind").notNull(),
  periodLabel: varchar("period_label", { length: 40 }).notNull(),
  portfolioId: uuid("portfolio_id"),
  status: reportReleaseStatusEnum("status").notNull().default("draft"),
  payload: jsonb("payload"),
  reconRunId: uuid("recon_run_id"),
  releasedBy: uuid("released_by"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  asOf: date("as_of").notNull(),
  status: reconStatusEnum("status").notNull().default("open"),
  cashDiff: numeric("cash_diff", { precision: 18, scale: 4 }).notNull().default("0"),
  holdingsDiffCount: integer("holdings_diff_count").notNull().default(0),
  notes: text("notes"),
  explanation: text("explanation"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  snapshot: jsonb("snapshot"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const opsFormEvents = pgTable("ops_form_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  formCode: varchar("form_code", { length: 10 }).notNull(),
  mandateId: uuid("mandate_id"),
  portfolioId: uuid("portfolio_id"),
  payload: jsonb("payload"),
  status: varchar("status", { length: 40 }).notNull().default("draft"),
  createdBy: uuid("created_by"),
  approvedBy: uuid("approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_ops_form_code").on(t.formCode)]);
