import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = process.env.GEMINI_API_KEY;

function getModel() {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not configured — add it to .env");
  const genAI = new GoogleGenerativeAI(API_KEY);
  return genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
}

interface ArticleInput {
  title: string;
  content: string | null;
  sector: string;
}

interface AnalysisResult {
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  impact: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  summary: string;
  keyDrivers: string[];
  risks: string[];
}

function fallbackAnalysis(article: ArticleInput): AnalysisResult {
  const keywords = article.title.toLowerCase() + " " + (article.content || "").toLowerCase();
  const positiveTerms = ["growth", "profit", "rise", "gain", "surge", "expansion", "positive", "upgrade", "strong", "upward"];
  const negativeTerms = ["fall", "drop", "loss", "decline", "risk", "weak", "negative", "downgrade", "crash", "plunge"];

  let posCount = 0;
  let negCount = 0;
  for (const t of positiveTerms) if (keywords.includes(t)) posCount++;
  for (const t of negativeTerms) if (keywords.includes(t)) negCount++;

  const sentiment: AnalysisResult["sentiment"] = posCount > negCount ? "POSITIVE" : negCount > posCount ? "NEGATIVE" : "NEUTRAL";
  const impact: AnalysisResult["impact"] = Math.max(posCount, negCount) >= 2 ? "HIGH" : Math.max(posCount, negCount) >= 1 ? "MEDIUM" : "LOW";
  const confidence = Math.min(65, 40 + Math.max(posCount, negCount) * 8);

  return {
    sentiment,
    impact,
    confidence,
    summary: `Keyword-based analysis of: "${article.title.substring(0, 100)}"`,
    keyDrivers: posCount > 0 ? positiveTerms.filter((t) => keywords.includes(t)).slice(0, 3) : [],
    risks: negCount > 0 ? negativeTerms.filter((t) => keywords.includes(t)).slice(0, 3) : [],
  };
}

const PROMPT_TEMPLATE = `You are a financial analyst specializing in Qatar Stock Exchange sectors.

Analyze the following news article and return a JSON response with these fields:
- sentiment: one of "POSITIVE", "NEUTRAL", "NEGATIVE"
- impact: one of "LOW", "MEDIUM", "HIGH"
- confidence: integer 0-100 representing how confident you are in this analysis
- summary: a 1-2 sentence summary of the article's relevance to the sector
- keyDrivers: array of strings (positive factors or opportunities mentioned)
- risks: array of strings (negative factors, risks, or challenges mentioned)

Sector: {sector}
Title: {title}
Content: {content}

IMPORTANT: Only analyze what is explicitly stated in the article. Do NOT generate buy/sell recommendations. Do NOT invent information not present in the article.

Return ONLY valid JSON, no markdown or code fences.`;

export async function analyzeArticle(article: ArticleInput): Promise<AnalysisResult> {
  if (!API_KEY) return fallbackAnalysis(article);

  const prompt = PROMPT_TEMPLATE
    .replace("{sector}", article.sector)
    .replace("{title}", article.title)
    .replace("{content}", article.content || "No content available");

  try {
    const model = getModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    let parsed: AnalysisResult;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse Gemini response: ${text}`);
      }
    }

    if (!parsed.sentiment || !["POSITIVE", "NEUTRAL", "NEGATIVE"].includes(parsed.sentiment)) {
      parsed.sentiment = "NEUTRAL";
    }
    if (!parsed.impact || !["LOW", "MEDIUM", "HIGH"].includes(parsed.impact)) {
      parsed.impact = "LOW";
    }
    if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 100) {
      parsed.confidence = 50;
    }
    if (!Array.isArray(parsed.keyDrivers)) parsed.keyDrivers = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    if (typeof parsed.summary !== "string") parsed.summary = "";

    return parsed;
  } catch (err: any) {
    console.error(`[gemini] AI analysis failed, using fallback: ${err.message}`);
    return fallbackAnalysis(article);
  }
}

interface ExplanationInput {
  sectorName: string;
  recommendation: string;
  score: number;
  confidence: number;
  totalArticles: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  drivers: string[];
  risks: string[];
  articleSummaries: string[];
}

function fallbackExplanation(input: ExplanationInput): string {
  const recMap: Record<string, string> = {
    STRONG_BUY: "strong buy",
    BUY: "buy",
    HOLD: "hold",
    REDUCE: "reduce",
    EXIT: "exit",
  };
  const recLabel = recMap[input.recommendation] || "hold";
  const driverText = input.drivers.length > 0
    ? `Key positive factors include: ${input.drivers.slice(0, 5).join(", ")}. `
    : "";
  const riskText = input.risks.length > 0
    ? `Notable risks include: ${input.risks.slice(0, 5).join(", ")}. `
    : "";
  const sentimentSummary = input.totalArticles > 0
    ? `The sentiment analysis across ${input.totalArticles} articles shows ${input.positiveCount} positive, ${input.neutralCount} neutral, and ${input.negativeCount} negative signals, resulting in a composite score of ${input.score}/100 with ${input.confidence}% confidence. `
    : "No articles have been analyzed for this sector yet. ";

  return `The ${input.sectorName} sector currently has a ${recLabel} recommendation (score: ${input.score}/100, confidence: ${input.confidence}%). ${sentimentSummary}${driverText}${riskText}This recommendation is data-driven and reflects the aggregate sentiment derived from available market intelligence.`;
}

const EXPLANATION_PROMPT = `You are a senior financial research analyst covering Qatar Stock Exchange sectors.

Write a clear, professional explanation (3-5 paragraphs) for why the following sector received its current recommendation. Focus on the data-driven reasoning. Do NOT generate buy/sell recommendations yourself — only explain the existing one.

Sector: {sectorName}
Current Recommendation: {recommendation}
Composite Score: {score}/100
Confidence: {confidence}%
Articles Analyzed: {totalArticles} ({positiveCount} positive, {neutralCount} neutral, {negativeCount} negative)

Key Positive Drivers:
{drivers}

Key Risks:
{risks}

Recent Article Highlights:
{articleSummaries}

Instructions:
- Write in a professional financial analyst tone.
- Explain how the sentiment distribution supports the current recommendation.
- Describe the key drivers and why they matter.
- Address the main risks and their potential impact on the outlook.
- Keep it concise but insightful — avoid fluff.
- Use natural paragraph breaks.
- Do NOT use markdown, bullet points, or numbered lists. Use flowing prose.`;

export async function generateSectorExplanation(input: ExplanationInput): Promise<string> {
  if (!API_KEY) return fallbackExplanation(input);

  const prompt = EXPLANATION_PROMPT
    .replace("{sectorName}", input.sectorName)
    .replace("{recommendation}", input.recommendation)
    .replace("{score}", String(input.score))
    .replace("{confidence}", String(input.confidence))
    .replace("{totalArticles}", String(input.totalArticles))
    .replace("{positiveCount}", String(input.positiveCount))
    .replace("{neutralCount}", String(input.neutralCount))
    .replace("{negativeCount}", String(input.negativeCount))
    .replace("{drivers}", input.drivers.length > 0 ? input.drivers.slice(0, 10).join(", ") : "None identified")
    .replace("{risks}", input.risks.length > 0 ? input.risks.slice(0, 10).join(", ") : "None identified")
    .replace("{articleSummaries}", input.articleSummaries.slice(0, 5).map((s, i) => `  - ${s}`).join("\n") || "None available");

  try {
    const model = getModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return text || fallbackExplanation(input);
  } catch (err: any) {
    console.error(`[gemini] Sector explanation failed, using fallback: ${err.message}`);
    return fallbackExplanation(input);
  }
}

export async function batchAnalyze(
  articles: ArticleInput[],
  concurrency = 3
): Promise<(AnalysisResult | null)[]> {
  const results: (AnalysisResult | null)[] = [];

  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((article) => analyzeArticle(article))
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        console.error(`[gemini] Analysis failed:`, r.reason?.message || r.reason);
        results.push(fallbackAnalysis(articles[results.length]));
      }
    }

    console.log(`[gemini] Analyzed ${Math.min(i + concurrency, articles.length)}/${articles.length} articles`);

    if (i + concurrency < articles.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}
