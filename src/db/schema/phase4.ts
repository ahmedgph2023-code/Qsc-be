import {
  pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, index, jsonb,
} from "drizzle-orm/pg-core";

export const aiPromptTypeEnum = pgEnum("ai_prompt_type", [
  "portfolio_summary",
  "risk_summary",
  "compliance_summary",
  "research_draft",
  "commentary_draft",
  "rebalance_explain",
  "ticker_ideas",
]);

export const commentaryStatusEnum = pgEnum("commentary_status", [
  "draft", "edited", "accepted", "rejected", "released",
]);

export const scenarioKindEnum = pgEnum("scenario_kind", [
  "multi_trade", "price_shock", "liquidity_stress", "cash_deploy", "benchmark_relative",
]);

export const aiGovernanceLogs = pgTable("ai_governance_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  promptType: aiPromptTypeEnum("prompt_type").notNull(),
  model: varchar("model", { length: 80 }).notNull().default("template"),
  userId: uuid("user_id"),
  objectType: varchar("object_type", { length: 80 }),
  objectId: uuid("object_id"),
  promptHash: varchar("prompt_hash", { length: 64 }),
  outputRef: text("output_ref"),
  accepted: boolean("accepted"),
  disclosure: varchar("disclosure", { length: 120 }).notNull().default("AI draft — not an approval"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_ai_gov_created").on(t.createdAt),
  index("idx_ai_gov_user").on(t.userId),
]);

export const commentaryDrafts = pgTable("commentary_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportReleaseId: uuid("report_release_id"),
  kind: varchar("kind", { length: 40 }).notNull(),
  periodLabel: varchar("period_label", { length: 40 }),
  portfolioId: uuid("portfolio_id"),
  body: text("body").notNull(),
  status: commentaryStatusEnum("status").notNull().default("draft"),
  aiLogId: uuid("ai_log_id"),
  createdBy: uuid("created_by"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_commentary_status").on(t.status)]);

export const scenarioRuns = pgTable("scenario_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }),
  kind: scenarioKindEnum("kind").notNull(),
  portfolioId: uuid("portfolio_id").notNull(),
  params: jsonb("params"),
  result: jsonb("result"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_scenario_portfolio").on(t.portfolioId)]);

export const efficientFrontierRuns = pgTable("efficient_frontier_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id").notNull(),
  mandateId: uuid("mandate_id"),
  methodology: varchar("methodology", { length: 80 }).notNull().default("unconfirmed_equal_risk"),
  assumptions: jsonb("assumptions"),
  params: jsonb("params"),
  result: jsonb("result"),
  status: varchar("status", { length: 40 }).notNull().default("completed"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/** Tools / actions the AI assistant must never expose (Blueprint §17 / D-006). */
export const FORBIDDEN_AI_ACTIONS = [
  "create_order",
  "transition_order",
  "record_fill",
  "approve_mandate",
  "approve_rebalance",
  "approve_exception",
  "approve_fee",
  "calculate_fee",
  "post_cash",
  "apply_corporate_action",
  "override_compliance",
  "change_ips_limits",
] as const;

export type AiPromptType =
  | "portfolio_summary"
  | "risk_summary"
  | "compliance_summary"
  | "research_draft"
  | "commentary_draft"
  | "rebalance_explain"
  | "ticker_ideas";
