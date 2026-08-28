import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { fetchAllNews, getUnanalyzedArticles } from "../services/news-fetcher.js";
import { batchAnalyze } from "../services/gemini.js";
import { recalculateSectorScores } from "../services/sector-scoring.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

router.get("/", async (_req, res) => {
  try {
    const sectorList = await db.select().from(schema.sectors);

    const dashboard = await Promise.all(
      sectorList.map(async (sector) => {
        const [score] = await db
          .select()
          .from(schema.sectorScores)
          .where(eq(schema.sectorScores.sectorId, sector.id))
          .limit(1);

        const [rec] = await db
          .select()
          .from(schema.sectorRecommendations)
          .where(eq(schema.sectorRecommendations.sectorId, sector.id))
          .limit(1);

        return {
          id: sector.id,
          name: sector.name,
          description: sector.description,
          recommendation: rec?.recommendation || "HOLD",
          score: rec ? Number(rec.score) : 50,
          confidence: rec?.confidence || 0,
          sentimentScore: score ? Number(score.sentimentScore) : 50,
          totalArticles: score?.totalArticles || 0,
          positiveArticles: score?.positiveCount || 0,
          neutralArticles: score?.neutralCount || 0,
          negativeArticles: score?.negativeCount || 0,
          positiveDrivers: rec?.positiveDrivers ? JSON.parse(rec.positiveDrivers) : [],
          topRisks: rec?.topRisks ? JSON.parse(rec.topRisks) : [],
          lastUpdated: rec?.updatedAt || sector.createdAt,
        };
      })
    );

    res.json(dashboard);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:sectorId", async (req, res) => {
  try {
    const { sectorId } = req.params;

    const [sector] = await db.select().from(schema.sectors).where(eq(schema.sectors.id, sectorId)).limit(1);
    if (!sector) { res.status(404).json({ error: "Sector not found" }); return; }

    const [score] = await db
      .select()
      .from(schema.sectorScores)
      .where(eq(schema.sectorScores.sectorId, sectorId))
      .limit(1);

    const [rec] = await db
      .select()
      .from(schema.sectorRecommendations)
      .where(eq(schema.sectorRecommendations.sectorId, sectorId))
      .limit(1);

    const articles = await db
      .select({
        id: schema.newsArticles.id,
        title: schema.newsArticles.title,
        source: schema.newsArticles.source,
        url: schema.newsArticles.url,
        publishedAt: schema.newsArticles.publishedAt,
        sentiment: schema.newsAnalysis.sentiment,
        impact: schema.newsAnalysis.impact,
        confidence: schema.newsAnalysis.confidence,
        summary: schema.newsAnalysis.summary,
        keyDrivers: schema.newsAnalysis.keyDrivers,
        risks: schema.newsAnalysis.risks,
      })
      .from(schema.newsArticles)
      .leftJoin(schema.newsAnalysis, eq(schema.newsArticles.id, schema.newsAnalysis.newsId))
      .where(eq(schema.newsArticles.sectorId, sectorId))
      .orderBy(desc(schema.newsArticles.publishedAt))
      .limit(50);

    res.json({
      id: sector.id,
      name: sector.name,
      description: sector.description,
      recommendation: rec?.recommendation || "HOLD",
      score: rec ? Number(rec.score) : 50,
      confidence: rec?.confidence || 0,
      sentimentScore: score ? Number(score.sentimentScore) : 50,
      totalArticles: score?.totalArticles || 0,
      positiveArticles: score?.positiveCount || 0,
      neutralArticles: score?.neutralCount || 0,
      negativeArticles: score?.negativeCount || 0,
      positiveDrivers: rec?.positiveDrivers ? JSON.parse(rec.positiveDrivers) : [],
      topRisks: rec?.topRisks ? JSON.parse(rec.topRisks) : [],
      explanation: rec?.explanation || null,
      lastUpdated: rec?.updatedAt || sector.createdAt,
      articles: articles.map((a) => ({
        id: a.id,
        title: a.title,
        source: a.source,
        url: a.url,
        publishedAt: a.publishedAt,
        sentiment: a.sentiment,
        impact: a.impact,
        confidence: a.confidence,
        summary: a.summary,
        keyDrivers: a.keyDrivers ? JSON.parse(a.keyDrivers) : [],
        risks: a.risks ? JSON.parse(a.risks) : [],
      })),
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:sectorId/news", async (req, res) => {
  try {
    const { sectorId } = req.params;
    const { sentiment, dateFrom, dateTo } = req.query;

    const conditions = [eq(schema.newsArticles.sectorId, sectorId)];

    if (dateFrom) conditions.push(gte(schema.newsArticles.publishedAt, new Date(dateFrom as string)));
    if (dateTo) conditions.push(lte(schema.newsArticles.publishedAt, new Date(dateTo as string)));

    const query = db
      .select({
        id: schema.newsArticles.id,
        title: schema.newsArticles.title,
        content: schema.newsArticles.content,
        source: schema.newsArticles.source,
        url: schema.newsArticles.url,
        publishedAt: schema.newsArticles.publishedAt,
        sentiment: schema.newsAnalysis.sentiment,
        impact: schema.newsAnalysis.impact,
        confidence: schema.newsAnalysis.confidence,
        summary: schema.newsAnalysis.summary,
      })
      .from(schema.newsArticles)
      .leftJoin(schema.newsAnalysis, eq(schema.newsArticles.id, schema.newsAnalysis.newsId))
      .where(and(...conditions))
      .orderBy(desc(schema.newsArticles.publishedAt))
      .limit(100);

    let articles = await query;

    if (sentiment) {
      articles = articles.filter((a) => a.sentiment === sentiment);
    }

    res.json(articles);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/fetch-news", requireRole("admin", "pm"), async (_req, res) => {
  try {
    console.log("[sectors] Manual news fetch triggered");
    const count = await fetchAllNews();
    res.json({ message: `Fetched ${count} new articles`, count });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/analyze", requireRole("admin", "pm"), async (_req, res) => {
  try {
    console.log("[sectors] Manual AI analysis triggered");
    const unanalyzed = await getUnanalyzedArticles();
    if (unanalyzed.length === 0) {
      res.json({ message: "No unanalyzed articles", analyzed: 0 });
      return;
    }

    const sectorMap = new Map<string, string>();
    const sectors = await db.select().from(schema.sectors);
    for (const s of sectors) sectorMap.set(s.id, s.name);

    const articlesForAI = unanalyzed.map((a) => ({
      title: a.title,
      content: a.content,
      sector: a.sectorId ? (sectorMap.get(a.sectorId) || "Unknown") : "Unknown",
    }));

    console.log(`[sectors] Analyzing ${articlesForAI.length} articles...`);
    const results = await batchAnalyze(articlesForAI);

    let analyzed = 0;
    for (let i = 0; i < unanalyzed.length; i++) {
      const result = results[i];
      if (!result) continue;

      await db.insert(schema.newsAnalysis).values({
        newsId: unanalyzed[i].id,
        sector: articlesForAI[i].sector,
        sentiment: result.sentiment,
        impact: result.impact,
        confidence: result.confidence,
        summary: result.summary,
        keyDrivers: JSON.stringify(result.keyDrivers),
        risks: JSON.stringify(result.risks),
      }).onConflictDoNothing();

      analyzed++;
    }

    console.log(`[sectors] Analyzed ${analyzed}/${unanalyzed.length} articles`);
    res.json({ message: `Analyzed ${analyzed} articles`, analyzed, total: unanalyzed.length });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/recalculate", requireRole("admin", "pm"), async (_req, res) => {
  try {
    console.log("[sectors] Manual score recalculation triggered");
    await recalculateSectorScores();
    res.json({ message: "Sector scores recalculated" });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.post("/full-refresh", requireRole("admin", "pm"), async (_req, res) => {
  try {
    console.log("[sectors] Full refresh triggered");

    console.log("[sectors] Step 1/3: Fetching news...");
    const fetchCount = await fetchAllNews();

    console.log("[sectors] Step 2/3: Analyzing articles...");
    const unanalyzed = await getUnanalyzedArticles();
    let analyzed = 0;
    if (unanalyzed.length > 0) {
      const sectorMap = new Map<string, string>();
      const sectors = await db.select().from(schema.sectors);
      for (const s of sectors) sectorMap.set(s.id, s.name);

      const articlesForAI = unanalyzed.map((a) => ({
        title: a.title,
        content: a.content,
        sector: a.sectorId ? (sectorMap.get(a.sectorId) || "Unknown") : "Unknown",
      }));

      const results = await batchAnalyze(articlesForAI);
      for (let i = 0; i < unanalyzed.length; i++) {
        const result = results[i];
        if (!result) continue;
        await db.insert(schema.newsAnalysis).values({
          newsId: unanalyzed[i].id,
          sector: articlesForAI[i].sector,
          sentiment: result.sentiment,
          impact: result.impact,
          confidence: result.confidence,
          summary: result.summary,
          keyDrivers: JSON.stringify(result.keyDrivers),
          risks: JSON.stringify(result.risks),
        }).onConflictDoNothing();
        analyzed++;
      }
    }

    console.log("[sectors] Step 3/3: Recalculating scores...");
    await recalculateSectorScores();

    console.log("[sectors] Full refresh complete");
    res.json({
      message: "Full refresh complete",
      articlesFetched: fetchCount,
      articlesAnalyzed: analyzed,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
