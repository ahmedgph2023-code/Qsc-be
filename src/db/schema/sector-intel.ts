import { pgTable, uuid, varchar, text, date, integer, numeric, timestamp, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const sentimentEnum = pgEnum("sentiment", ["POSITIVE", "NEUTRAL", "NEGATIVE"]);
export const impactEnum = pgEnum("impact", ["LOW", "MEDIUM", "HIGH"]);
export const recommendationEnum = pgEnum("recommendation", ["STRONG_BUY", "BUY", "HOLD", "REDUCE", "EXIT"]);

export const sectors = pgTable("sectors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull().unique(),
  description: text("description"),
  keywords: text("keywords"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const newsArticles = pgTable("news_articles", {
  id: uuid("id").defaultRandom().primaryKey(),
  sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content"),
  source: varchar("source", { length: 200 }),
  url: text("url").notNull().unique(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_news_sector").on(table.sectorId),
  index("idx_news_published").on(table.publishedAt),
]);

export const newsAnalysis = pgTable("news_analysis", {
  id: uuid("id").defaultRandom().primaryKey(),
  newsId: uuid("news_id").notNull().references(() => newsArticles.id, { onDelete: "cascade" }).unique(),
  sector: varchar("sector", { length: 200 }),
  sentiment: sentimentEnum("sentiment").notNull(),
  impact: impactEnum("impact").notNull(),
  confidence: integer("confidence").notNull(),
  summary: text("summary"),
  keyDrivers: text("key_drivers"),
  risks: text("risks"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_analysis_sector").on(table.sector),
]);

export const sectorScores = pgTable("sector_scores", {
  id: uuid("id").defaultRandom().primaryKey(),
  sectorId: uuid("sector_id").notNull().references(() => sectors.id, { onDelete: "cascade" }).unique(),
  sentimentScore: numeric("sentiment_score", { precision: 8, scale: 4 }).notNull(),
  positiveCount: integer("positive_count").notNull().default(0),
  neutralCount: integer("neutral_count").notNull().default(0),
  negativeCount: integer("negative_count").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  totalArticles: integer("total_articles").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const sectorRecommendations = pgTable("sector_recommendations", {
  id: uuid("id").defaultRandom().primaryKey(),
  sectorId: uuid("sector_id").notNull().references(() => sectors.id, { onDelete: "cascade" }).unique(),
  recommendation: recommendationEnum("recommendation").notNull(),
  score: numeric("score", { precision: 8, scale: 4 }).notNull(),
  confidence: integer("confidence").notNull().default(0),
  positiveDrivers: text("positive_drivers"),
  topRisks: text("top_risks"),
  explanation: text("explanation"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const sectorsRelations = relations(sectors, ({ many }) => ({
  newsArticles: many(newsArticles),
  sectorScore: many(sectorScores),
  sectorRecommendation: many(sectorRecommendations),
}));

export const newsArticlesRelations = relations(newsArticles, ({ one, many }) => ({
  sector: one(sectors, { fields: [newsArticles.sectorId], references: [sectors.id] }),
  analysis: many(newsAnalysis),
}));

export const newsAnalysisRelations = relations(newsAnalysis, ({ one }) => ({
  newsArticle: one(newsArticles, { fields: [newsAnalysis.newsId], references: [newsArticles.id] }),
}));

export const sectorScoresRelations = relations(sectorScores, ({ one }) => ({
  sector: one(sectors, { fields: [sectorScores.sectorId], references: [sectors.id] }),
}));

export const sectorRecommendationsRelations = relations(sectorRecommendations, ({ one }) => ({
  sector: one(sectors, { fields: [sectorRecommendations.sectorId], references: [sectors.id] }),
}));
