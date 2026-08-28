import {
  pgTable, uuid, varchar, text, date, numeric, timestamp, boolean, integer,
  pgEnum, uniqueIndex, jsonb, index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────
export const mandateTypeEnum = pgEnum("mandate_type", ["discretionary"]);
export const shariahPreferenceEnum = pgEnum("shariah_preference", ["fully_shariah", "shariah_purifying", "unrestricted"]);
export const riskProfileEnum = pgEnum("risk_profile", ["medium", "high"]);
export const mandateApprovalStatusEnum = pgEnum("mandate_approval_status", ["pending", "approved", "amended", "closed", "rejected"]);
export const restrictionTypeEnum = pgEnum("restriction_type", ["stock", "sector", "other"]);
export const constructionStyleEnum = pgEnum("construction_style", ["core_satellite", "full_active"]);
export const modelStatusEnum = pgEnum("model_status", ["draft", "active", "retired"]);
export const builderTargetTypeEnum = pgEnum("builder_target_type", ["model", "client"]);
export const rebalanceTriggerEnum = pgEnum("rebalance_trigger", [
  "quarterly_review", "benchmark_change", "active_review", "breach", "cash_deposit", "cash_withdrawal", "ad_hoc",
]);
export const rebalanceLockStatusEnum = pgEnum("rebalance_lock_status", ["draft", "approved", "executed", "final", "cancelled"]);
export const complianceTimingEnum = pgEnum("compliance_timing", ["before_proposal", "before_trade", "after_trade"]);
export const checkResultEnum = pgEnum("check_result", ["pass", "fail", "warning"]);
export const exceptionStatusEnum = pgEnum("exception_status", ["requested", "approved", "rejected", "expired", "used"]);
export const riskAlertTypeEnum = pgEnum("risk_alert_type", [
  "stock_weight_15", "stock_weight_20", "sector_weight_35", "sector_weight_40",
  "stock_loss_15", "stock_loss_25", "stock_loss_30", "underperform_3m", "excess_cash", "liquidity", "regulatory",
]);
export const alertSeverityEnum = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertStatusEnum = pgEnum("alert_status", ["open", "in_progress", "resolved", "waived"]);
export const cashTxTypeEnum = pgEnum("cash_tx_type", [
  "deposit", "withdrawal", "fee", "dividend", "adjustment", "coupon", "maturity_principal",
  "trade_buy", "trade_sell", "commission_rebate",
]);
export const performanceFrequencyEnum = pgEnum("performance_frequency", ["annual", "quarterly"]);
export const feeChargeTypeEnum = pgEnum("fee_charge_type", [
  "rebate_commission", "management_fee", "performance_fee",
]);
export const feeChargeStatusEnum = pgEnum("fee_charge_status", ["pending", "approved", "rejected"]);
export const auditActionEnum = pgEnum("audit_action", [
  "create", "update", "delete", "approve", "reject", "status_change", "override", "login", "export", "correction",
]);

// FKs use uuid columns (app-enforced) to avoid circular imports with core schema.

export const mandates = pgTable("mandates", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id").notNull().unique(),
  mandateType: mandateTypeEnum("mandate_type").notNull().default("discretionary"),
  shariahPreference: shariahPreferenceEnum("shariah_preference").notNull(),
  riskProfile: riskProfileEnum("risk_profile").notNull(),
  benchmarkIndexId: uuid("benchmark_index_id"),
  modelPortfolioId: uuid("model_portfolio_id"),
  approvalStatus: mandateApprovalStatusEnum("approval_status").notNull().default("pending"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  contractStart: date("contract_start"),
  contractEnd: date("contract_end"),
  initialValue: numeric("initial_value", { precision: 18, scale: 4 }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const mandateRestrictions = pgTable("mandate_restrictions", {
  id: uuid("id").defaultRandom().primaryKey(),
  mandateId: uuid("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  restrictionType: restrictionTypeEnum("restriction_type").notNull(),
  stockId: uuid("stock_id"),
  sector: varchar("sector", { length: 100 }),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const mandateFeeBands = pgTable("mandate_fee_bands", {
  id: uuid("id").defaultRandom().primaryKey(),
  mandateId: uuid("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  rebateCommissionPct: numeric("rebate_commission_pct", { precision: 12, scale: 6 }).notNull().default("0"),
  annualManagementFeePct: numeric("annual_management_fee_pct", { precision: 12, scale: 6 }).notNull().default("0"),
  performanceFeePct: numeric("performance_fee_pct", { precision: 12, scale: 6 }).notNull().default("0"),
  performanceFrequency: performanceFrequencyEnum("performance_frequency").notNull().default("annual"),
  performanceHurdlePct: numeric("performance_hurdle_pct", { precision: 12, scale: 6 }).notNull().default("0"),
  highWaterMark: numeric("high_water_mark", { precision: 18, scale: 4 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_fee_bands_mandate").on(t.mandateId, t.effectiveFrom)]);

export const feeCharges = pgTable("fee_charges", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  mandateId: uuid("mandate_id").notNull(),
  feeBandId: uuid("fee_band_id"),
  type: feeChargeTypeEnum("type").notNull(),
  periodMonth: date("period_month").notNull(),
  periodEndDate: date("period_end_date").notNull(),
  notional: numeric("notional", { precision: 18, scale: 4 }).notNull().default("0"),
  holdingsMv: numeric("holdings_mv", { precision: 18, scale: 4 }).notNull().default("0"),
  cashAsOf: numeric("cash_as_of", { precision: 18, scale: 4 }).notNull().default("0"),
  nav: numeric("nav", { precision: 18, scale: 4 }).notNull().default("0"),
  ratePct: numeric("rate_pct", { precision: 12, scale: 6 }).notNull().default("0"),
  amount: numeric("amount", { precision: 18, scale: 4 }).notNull().default("0"),
  hwmBefore: numeric("hwm_before", { precision: 18, scale: 4 }),
  excess: numeric("excess", { precision: 18, scale: 4 }),
  twrPct: numeric("twr_pct", { precision: 12, scale: 6 }),
  status: feeChargeStatusEnum("status").notNull().default("pending"),
  cashTransactionId: uuid("cash_transaction_id"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedBy: uuid("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  decisionReason: text("decision_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fee_charge_unique").on(t.portfolioId, t.periodMonth, t.type),
  index("idx_fee_charges_status").on(t.status, t.periodMonth),
]);

export const mandateStatusHistory = pgTable("mandate_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  mandateId: uuid("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  fromStatus: mandateApprovalStatusEnum("from_status"),
  toStatus: mandateApprovalStatusEnum("to_status").notNull(),
  changedBy: uuid("changed_by"),
  reason: text("reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow(),
});

export const indexConstituents = pgTable("index_constituents", {
  id: uuid("id").defaultRandom().primaryKey(),
  indexId: uuid("index_id").notNull(),
  stockId: uuid("stock_id").notNull(),
  weight: numeric("weight", { precision: 12, scale: 8 }).notNull(),
  effectiveDate: date("effective_date").notNull(),
}, (t) => [
  uniqueIndex("idx_constituent_unique").on(t.indexId, t.stockId, t.effectiveDate),
]);

export const cashTransactions = pgTable("cash_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  type: cashTxTypeEnum("type").notNull(),
  amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
  tradeDate: date("trade_date").notNull(),
  valueDate: date("value_date"),
  reference: varchar("reference", { length: 100 }),
  notes: text("notes"),
  createdBy: uuid("created_by"),
  corporateActionId: uuid("corporate_action_id"),
  stockTransactionId: uuid("stock_transaction_id"),
  sourceImportId: uuid("source_import_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_cash_portfolio_date").on(t.portfolioId, t.tradeDate),
  index("idx_cash_source_import").on(t.sourceImportId),
]);

export const historicalImportKindEnum = pgEnum("historical_import_kind", [
  "securities", "prices", "indices", "client", "trades", "cash",
]);
export const historicalImportStatusEnum = pgEnum("historical_import_status", [
  "committed", "replaced", "deleted",
]);

/** Registry of QSC broker-sheet imports (not the IPMS Bulk Upload template). */
export const historicalImports = pgTable("historical_imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: historicalImportKindEnum("kind").notNull(),
  status: historicalImportStatusEnum("status").notNull().default("committed"),
  fileName: varchar("file_name", { length: 300 }).notNull(),
  rowCount: integer("row_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  customerId: uuid("customer_id"),
  portfolioId: uuid("portfolio_id"),
  clientKey: varchar("client_key", { length: 80 }),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  replacedById: uuid("replaced_by_id"),
}, (t) => [index("idx_hist_import_kind_status").on(t.kind, t.status)]);

export const modelPortfolios = pgTable("model_portfolios", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  shariahPreference: shariahPreferenceEnum("shariah_preference").notNull(),
  riskProfile: riskProfileEnum("risk_profile").notNull(),
  benchmarkIndexId: uuid("benchmark_index_id"),
  constructionStyle: constructionStyleEnum("construction_style").notNull(),
  coreWeight: numeric("core_weight", { precision: 8, scale: 4 }).notNull().default("0.65"),
  satelliteWeight: numeric("satellite_weight", { precision: 8, scale: 4 }).notNull().default("0.35"),
  status: modelStatusEnum("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const modelHoldings = pgTable("model_holdings", {
  id: uuid("id").defaultRandom().primaryKey(),
  modelPortfolioId: uuid("model_portfolio_id").notNull().references(() => modelPortfolios.id, { onDelete: "cascade" }),
  stockId: uuid("stock_id").notNull(),
  targetWeight: numeric("target_weight", { precision: 12, scale: 8 }).notNull(),
  sleeve: varchar("sleeve", { length: 20 }).notNull().default("active"),
}, (t) => [uniqueIndex("idx_model_holding_unique").on(t.modelPortfolioId, t.stockId)]);

export const builderSessions = pgTable("builder_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetType: builderTargetTypeEnum("target_type").notNull(),
  modelPortfolioId: uuid("model_portfolio_id"),
  portfolioId: uuid("portfolio_id"),
  mandateId: uuid("mandate_id"),
  status: varchar("status", { length: 40 }).notNull().default("drafting"),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const rebalances = pgTable("rebalances", {
  id: uuid("id").defaultRandom().primaryKey(),
  rebalanceCode: varchar("rebalance_code", { length: 40 }).notNull().unique(),
  portfolioId: uuid("portfolio_id"),
  modelPortfolioId: uuid("model_portfolio_id"),
  trigger: rebalanceTriggerEnum("trigger").notNull().default("ad_hoc"),
  lockStatus: rebalanceLockStatusEnum("lock_status").notNull().default("draft"),
  proposedAt: timestamp("proposed_at", { withTimezone: true }).defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  preparedBy: uuid("prepared_by"),
  reviewedBy: uuid("reviewed_by"),
  approvedBy: uuid("approved_by"),
  beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>(),
  afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>(),
  targetAllocation: jsonb("target_allocation").$type<Record<string, unknown>>(),
  complianceSummary: jsonb("compliance_summary").$type<Record<string, unknown>>(),
  allocationMethod: varchar("allocation_method", { length: 40 }),
  documents: jsonb("documents").$type<unknown[]>().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_rebalance_portfolio").on(t.portfolioId, t.lockStatus)]);

export const rebalanceProposedTrades = pgTable("rebalance_proposed_trades", {
  id: uuid("id").defaultRandom().primaryKey(),
  rebalanceId: uuid("rebalance_id").notNull().references(() => rebalances.id, { onDelete: "cascade" }),
  stockId: uuid("stock_id").notNull(),
  side: varchar("side", { length: 10 }).notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  estimatedPrice: numeric("estimated_price", { precision: 18, scale: 4 }),
  estimatedValue: numeric("estimated_value", { precision: 18, scale: 4 }),
  reason: text("reason"),
  complianceResult: checkResultEnum("compliance_result"),
});

export const rebalanceCorrections = pgTable("rebalance_corrections", {
  id: uuid("id").defaultRandom().primaryKey(),
  rebalanceId: uuid("rebalance_id").notNull().references(() => rebalances.id, { onDelete: "cascade" }),
  fieldPath: text("field_path").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  reason: text("reason").notNull(),
  correctedBy: uuid("corrected_by"),
  correctedAt: timestamp("corrected_at", { withTimezone: true }).defaultNow(),
});

export const ipsLimitConfig = pgTable("ips_limit_config", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: numeric("value", { precision: 18, scale: 8 }).notNull(),
  unit: varchar("unit", { length: 20 }).notNull().default("ratio"),
  description: text("description"),
});

/** Super-admin feature flags and product toggles (not money formulas). */
export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: varchar("value", { length: 200 }).notNull(),
  valueType: varchar("value_type", { length: 20 }).notNull().default("boolean"),
  category: varchar("category", { length: 40 }).notNull().default("flags"),
  description: text("description"),
  confirmed: boolean("confirmed").notNull().default(false),
  source: varchar("source", { length: 80 }).notNull().default("blueprint_default"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/** Super-admin editable Investment Portfolio formulas (Excel Table1 defaults). Engine evaluates these server-side. */
export const portfolioFormulas = pgTable("portfolio_formulas", {
  key: varchar("key", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 160 }).notNull(),
  category: varchar("category", { length: 40 }).notNull().default("row"),
  excelFormula: text("excel_formula").notNull(),
  expression: text("expression").notNull(),
  inputs: jsonb("inputs").$type<string[]>().notNull().default([]),
  description: text("description"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const complianceResults = pgTable("compliance_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  rebalanceId: uuid("rebalance_id"),
  portfolioId: uuid("portfolio_id"),
  checkCode: varchar("check_code", { length: 64 }).notNull(),
  timing: complianceTimingEnum("timing").notNull().default("before_proposal"),
  result: checkResultEnum("result").notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  message: text("message"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const complianceExceptions = pgTable("compliance_exceptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  checkCode: varchar("check_code", { length: 64 }).notNull(),
  reason: text("reason").notNull(),
  status: exceptionStatusEnum("status").notNull().default("requested"),
  requestedBy: uuid("requested_by"),
  approvedBy: uuid("approved_by"),
  validUntil: date("valid_until"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const riskAlerts = pgTable("risk_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  alertType: riskAlertTypeEnum("alert_type").notNull(),
  severity: alertSeverityEnum("severity").notNull().default("warning"),
  status: alertStatusEnum("status").notNull().default("open"),
  stockId: uuid("stock_id"),
  sector: varchar("sector", { length: 100 }),
  metricValue: numeric("metric_value", { precision: 18, scale: 8 }),
  threshold: numeric("threshold", { precision: 18, scale: 8 }),
  dueDate: date("due_date"),
  ownerId: uuid("owner_id"),
  resolutionNotes: text("resolution_notes"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("idx_risk_alerts_open").on(t.portfolioId, t.status)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  userId: uuid("user_id"),
  action: auditActionEnum("action").notNull(),
  objectType: varchar("object_type", { length: 64 }).notNull(),
  objectId: uuid("object_id"),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  reason: text("reason"),
  ipAddress: varchar("ip_address", { length: 64 }),
}, (t) => [
  index("idx_audit_occurred").on(t.occurredAt),
  index("idx_audit_object").on(t.objectType, t.objectId),
]);

export const mandatesRelations = relations(mandates, ({ many }) => ({
  restrictions: many(mandateRestrictions),
  statusHistory: many(mandateStatusHistory),
  feeBands: many(mandateFeeBands),
}));

export const mandateFeeBandsRelations = relations(mandateFeeBands, ({ one }) => ({
  mandate: one(mandates, { fields: [mandateFeeBands.mandateId], references: [mandates.id] }),
}));

export const modelPortfoliosRelations = relations(modelPortfolios, ({ many }) => ({
  holdings: many(modelHoldings),
}));

export const rebalancesRelations = relations(rebalances, ({ many }) => ({
  proposedTrades: many(rebalanceProposedTrades),
  corrections: many(rebalanceCorrections),
}));
