import { pgTable, uuid, varchar, date, numeric, timestamp, boolean, integer, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

/** Cloudilic as-of snapshot vs SQL ClientPortfolioSnapshot. Unique per (clientId, date). */
export const ipmsClientSnapshots = pgTable("ipms_client_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: integer("client_id").notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  nin: varchar("nin", { length: 32 }),
  name: varchar("name", { length: 300 }),
  ipmsMarketValue: numeric("ipms_market_value", { precision: 18, scale: 4 }),
  ipmsCash: numeric("ipms_cash", { precision: 18, scale: 4 }).notNull(),
  ipmsNavMvPlusCash: numeric("ipms_nav_mv_plus_cash", { precision: 18, scale: 4 }),
  missingCloses: jsonb("missing_closes").$type<string[]>().notNull().default([]),
  qscPortfolioValue: numeric("qsc_portfolio_value", { precision: 18, scale: 4 }),
  qscSystemCash: numeric("qsc_system_cash", { precision: 18, scale: 4 }),
  qscBankBalance: numeric("qsc_bank_balance", { precision: 18, scale: 4 }),
  qscUpdatedAt: timestamp("qsc_updated_at", { withTimezone: true }),
  cashMatch: boolean("cash_match"),
  mvMatch: boolean("mv_match"),
  navMatch: boolean("nav_match"),
  status: varchar("status", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("ipms_client_snapshots_client_date").on(t.clientId, t.snapshotDate),
  index("ipms_client_snapshots_date").on(t.snapshotDate),
  index("ipms_client_snapshots_status").on(t.status),
]);
