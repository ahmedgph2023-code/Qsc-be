import {
  pgTable, uuid, varchar, text, date, numeric, timestamp, integer, boolean,
  pgEnum, index, jsonb, uniqueIndex,
} from "drizzle-orm/pg-core";

export const approvedListStatusEnum = pgEnum("approved_list_status", [
  "approved_buy", "hold", "sell_only", "watchlist", "restricted",
]);

export const researchLayerEnum = pgEnum("research_layer", [
  "macro", "fundamental", "valuation", "internal", "technical",
]);

export const researchLayerStatusEnum = pgEnum("research_layer_status", [
  "incomplete", "pass", "watch", "fail",
]);

export const strategyApprovalStatusEnum = pgEnum("strategy_approval_status", [
  "draft", "pending_ic", "approved", "retired",
]);

export const stockApprovedList = pgTable("stock_approved_list", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().unique(),
  status: approvedListStatusEnum("status").notNull().default("watchlist"),
  notes: text("notes"),
  changedBy: uuid("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_approved_list_status").on(t.status)]);

export const researchLayerAssessments = pgTable("research_layer_assessments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull(),
  layer: researchLayerEnum("layer").notNull(),
  status: researchLayerStatusEnum("status").notNull().default("incomplete"),
  notes: text("notes"),
  analystName: varchar("analyst_name", { length: 200 }),
  assessedAt: date("assessed_at"),
  evidenceUrl: text("evidence_url"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("uq_research_stock_layer").on(t.stockId, t.layer),
  index("idx_research_layers_stock").on(t.stockId),
]);

export const researchLayerExceptions = pgTable("research_layer_exceptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull(),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  requestedBy: uuid("requested_by"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const shariaEsgReviews = pgTable("sharia_esg_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull(),
  shariahGroup: varchar("shariah_group", { length: 20 }),
  reviewDate: date("review_date"),
  reviewerName: varchar("reviewer_name", { length: 200 }),
  evidenceNotes: text("evidence_notes"),
  esgScore: varchar("esg_score", { length: 40 }),
  esgNotes: text("esg_notes"),
  syncToStock: boolean("sync_to_stock").notNull().default(false),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_sharia_esg_stock").on(t.stockId)]);

export const investmentStrategies = pgTable("investment_strategies", {
  id: uuid("id").defaultRandom().primaryKey(),
  modelCode: varchar("model_code", { length: 40 }).notNull().unique(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  parameters: jsonb("parameters"),
  positioningNotes: text("positioning_notes"),
  approvalStatus: strategyApprovalStatusEnum("approval_status").notNull().default("draft"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const stockScoreConfig = pgTable("stock_score_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull().default("default"),
  factors: jsonb("factors"),
  confirmed: boolean("confirmed").notNull().default(false),
  notes: text("notes"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const stockScores = pgTable("stock_scores", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().unique(),
  score: numeric("score", { precision: 10, scale: 4 }),
  rank: integer("rank"),
  breakdown: jsonb("breakdown"),
  asOf: date("as_of"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const RESEARCH_LAYERS = [
  "macro", "fundamental", "valuation", "internal", "technical",
] as const;

export type ResearchLayer = (typeof RESEARCH_LAYERS)[number];
export type ApprovedListStatus =
  | "approved_buy" | "hold" | "sell_only" | "watchlist" | "restricted";
