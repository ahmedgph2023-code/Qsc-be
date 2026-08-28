import { db, schema } from "../db/connection.js";
import { eq, sql } from "drizzle-orm";
import { generateSectorExplanation } from "./gemini.js";

const SENTIMENT_VALUE: Record<string, number> = {
  POSITIVE: 1,
  NEUTRAL: 0,
  NEGATIVE: -1,
};

const IMPACT_WEIGHT: Record<string, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

interface SectorAnalysisData {
  sentiment: string;
  impact: string;
  confidence: number;
}

function calculateSentimentScore(analyses: SectorAnalysisData[]): number {
  if (analyses.length === 0) return 50;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const a of analyses) {
    const sentimentVal = SENTIMENT_VALUE[a.sentiment] ?? 0;
    const impactW = IMPACT_WEIGHT[a.impact] ?? 1;
    const confW = a.confidence / 100;
    const weight = impactW * confW;
    weightedSum += sentimentVal * weight;
    weightTotal += weight;
  }

  if (weightTotal === 0) return 50;

  const normalized = weightedSum / weightTotal;
  return Math.round(((normalized + 1) / 2) * 100 * 10000) / 10000;
}

function calculateConfidence(analyses: SectorAnalysisData[]): number {
  if (analyses.length === 0) return 0;

  const coverage = Math.min(analyses.length / 10, 1) * 40;

  const sentiments = analyses.map((a) => SENTIMENT_VALUE[a.sentiment] ?? 0);
  const mean = sentiments.reduce((s, v) => s + v, 0) / sentiments.length;
  const variance = sentiments.reduce((s, v) => s + (v - mean) ** 2, 0) / sentiments.length;
  const stdDev = Math.sqrt(variance);
  const agreement = (1 - stdDev) * 40;

  const impacts = analyses.map((a) => IMPACT_WEIGHT[a.impact] ?? 1);
  const impactMean = impacts.reduce((s, v) => s + v, 0) / impacts.length;
  const impactVariance = impacts.reduce((s, v) => s + (v - impactMean) ** 2, 0) / impacts.length;
  const impactStdDev = Math.sqrt(impactVariance);
  const impactConsistency = Math.max(0, (1 - impactStdDev / 2)) * 10;

  const recency = 10;

  const total = coverage + Math.max(0, agreement) + impactConsistency + recency;
  return Math.round(Math.min(100, Math.max(0, total)));
}

function getRecommendation(score: number): "STRONG_BUY" | "BUY" | "HOLD" | "REDUCE" | "EXIT" {
  if (score >= 80) return "STRONG_BUY";
  if (score >= 65) return "BUY";
  if (score >= 50) return "HOLD";
  if (score >= 35) return "REDUCE";
  return "EXIT";
}

export async function recalculateSectorScores(): Promise<void> {
  const sectorList = await db.select().from(schema.sectors);

  for (const sector of sectorList) {
    console.log(`[scoring] Recalculating scores for ${sector.name}...`);

    const analyses = await db
      .select({
        sentiment: schema.newsAnalysis.sentiment,
        impact: schema.newsAnalysis.impact,
        confidence: schema.newsAnalysis.confidence,
      })
      .from(schema.newsAnalysis)
      .innerJoin(schema.newsArticles, eq(schema.newsAnalysis.newsId, schema.newsArticles.id))
      .where(eq(schema.newsArticles.sectorId, sector.id));

    const positiveCount = analyses.filter((a) => a.sentiment === "POSITIVE").length;
    const neutralCount = analyses.filter((a) => a.sentiment === "NEUTRAL").length;
    const negativeCount = analyses.filter((a) => a.sentiment === "NEGATIVE").length;

    const sentimentScore = calculateSentimentScore(analyses);
    const confidence = calculateConfidence(analyses);
    const recommendation = getRecommendation(sentimentScore);

    const positiveDrivers = await db
      .select({ keyDrivers: schema.newsAnalysis.keyDrivers })
      .from(schema.newsAnalysis)
      .innerJoin(schema.newsArticles, eq(schema.newsAnalysis.newsId, schema.newsArticles.id))
      .where(eq(schema.newsArticles.sectorId, sector.id));

    const allDrivers: string[] = [];
    const allRisks: string[] = [];
    for (const row of positiveDrivers) {
      if (row.keyDrivers) {
        try {
          const parsed = JSON.parse(row.keyDrivers);
          if (Array.isArray(parsed)) allDrivers.push(...parsed);
        } catch { /* skip */ }
      }
    }

    const riskRows = await db
      .select({ risks: schema.newsAnalysis.risks })
      .from(schema.newsAnalysis)
      .innerJoin(schema.newsArticles, eq(schema.newsAnalysis.newsId, schema.newsArticles.id))
      .where(eq(schema.newsArticles.sectorId, sector.id));

    for (const row of riskRows) {
      if (row.risks) {
        try {
          const parsed = JSON.parse(row.risks);
          if (Array.isArray(parsed)) allRisks.push(...parsed);
        } catch { /* skip */ }
      }
    }

    const uniqueDrivers = [...new Set(allDrivers)].slice(0, 10);
    const uniqueRisks = [...new Set(allRisks)].slice(0, 10);

    const summaries = await db
      .select({ summary: schema.newsAnalysis.summary })
      .from(schema.newsAnalysis)
      .innerJoin(schema.newsArticles, eq(schema.newsAnalysis.newsId, schema.newsArticles.id))
      .where(eq(schema.newsArticles.sectorId, sector.id))
      .limit(10);

    const articleSummaries = summaries
      .map((s) => s.summary)
      .filter((s): s is string => typeof s === "string" && s.length > 0);

    const explanation = await generateSectorExplanation({
      sectorName: sector.name,
      recommendation,
      score: sentimentScore,
      confidence,
      totalArticles: analyses.length,
      positiveCount,
      neutralCount,
      negativeCount,
      drivers: uniqueDrivers,
      risks: uniqueRisks,
      articleSummaries,
    });

    console.log(`[scoring] Explanation generated for ${sector.name} (${explanation.length} chars)`);

    await db.insert(schema.sectorScores).values({
      sectorId: sector.id,
      sentimentScore: String(sentimentScore),
      positiveCount,
      neutralCount,
      negativeCount,
      confidence,
      totalArticles: analyses.length,
    }).onConflictDoUpdate({
      target: schema.sectorScores.sectorId,
      set: {
        sentimentScore: String(sentimentScore),
        positiveCount,
        neutralCount,
        negativeCount,
        confidence,
        totalArticles: analyses.length,
        updatedAt: new Date(),
      },
    });

    await db.insert(schema.sectorRecommendations).values({
      sectorId: sector.id,
      recommendation,
      score: String(sentimentScore),
      confidence,
      positiveDrivers: JSON.stringify(uniqueDrivers),
      topRisks: JSON.stringify(uniqueRisks),
      explanation,
    }).onConflictDoUpdate({
      target: schema.sectorRecommendations.sectorId,
      set: {
        recommendation,
        score: String(sentimentScore),
        confidence,
        positiveDrivers: JSON.stringify(uniqueDrivers),
        topRisks: JSON.stringify(uniqueRisks),
        explanation,
        updatedAt: new Date(),
      },
    });

    console.log(`[scoring] ${sector.name}: score=${sentimentScore}, rec=${recommendation}, conf=${confidence}, articles=${analyses.length}`);
  }

  console.log("[scoring] All sector scores recalculated");
}
