import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db, schema } from "../db/connection.js";
import { FORBIDDEN_AI_ACTIONS, type AiPromptType } from "../db/schema/phase4.js";
import { getPortfolioHoldings, getDashboardMetrics } from "./calculations.js";
import { listRecentCompliance } from "./compliance-engine.js";
import { writeAudit } from "./audit.js";

const DISCLOSURE = "AI draft — not an approval";
const API_KEY = process.env.GEMINI_API_KEY;

export { FORBIDDEN_AI_ACTIONS };

export const ALLOWED_AI_PROMPT_TYPES: AiPromptType[] = [
  "portfolio_summary",
  "risk_summary",
  "compliance_summary",
  "research_draft",
  "commentary_draft",
  "rebalance_explain",
  "ticker_ideas",
];

/** Pure export for tests: assistant surface never includes forbidden actions. */
export function getAiAssistantToolSurface() {
  return {
    allowedPromptTypes: [...ALLOWED_AI_PROMPT_TYPES],
    forbiddenActions: [...FORBIDDEN_AI_ACTIONS],
    canExecuteTrades: false,
    canApproveAnything: false,
    canOverrideCompliance: false,
    canTouchFees: false,
  };
}

function hashPrompt(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

async function maybeGemini(prompt: string): Promise<{ text: string; model: string }> {
  if (!API_KEY) {
    return { text: "", model: "template" };
  }
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(
      `${prompt}\n\nIMPORTANT: Analysis-only draft. Do NOT approve trades, mandates, fees, or override compliance. Do NOT invent NAV or holdings numbers not provided.`,
    );
    return { text: result.response.text().trim(), model: "gemini-2.0-flash" };
  } catch (err) {
    console.error("[ai-assistant] gemini failed", err);
    return { text: "", model: "template" };
  }
}

async function buildContext(params: {
  promptType: AiPromptType;
  portfolioId?: string;
  extra?: string;
}) {
  const parts: string[] = [
    `Prompt type: ${params.promptType}`,
    `Disclosure: ${DISCLOSURE}`,
  ];

  if (params.portfolioId) {
    const [portfolio] = await db.select().from(schema.portfolios)
      .where(eq(schema.portfolios.id, params.portfolioId)).limit(1);
    if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });
    const holdings = await getPortfolioHoldings(params.portfolioId);
    const equity = holdings.reduce((s, h) => s + h.currentValue, 0);
    const cash = Number(portfolio.cashBalance ?? 0);
    const nav = cash + equity;
    parts.push(`Portfolio cash QAR ${cash.toFixed(0)}; equity QAR ${equity.toFixed(0)}; NAV QAR ${nav.toFixed(0)}.`);
    parts.push(`Holdings (${holdings.length}): ${holdings.slice(0, 12).map((h) => {
      const w = nav > 0 ? (h.currentValue / nav) * 100 : 0;
      return `${h.ticker} ${w.toFixed(1)}%`;
    }).join(", ")}`);
    if (params.promptType === "compliance_summary") {
      const recent = await listRecentCompliance(params.portfolioId, 8);
      parts.push(`Recent compliance: ${recent.map((c) => `${c.checkCode}=${c.result}`).join("; ") || "none"}`);
    }
  } else if (params.promptType === "commentary_draft") {
    const dash = await getDashboardMetrics();
    parts.push(`Firm AUM QAR ${Number(dash.totalAum ?? 0).toFixed(0)}; daily P&L ${Number(dash.dailyPnL ?? 0).toFixed(0)}.`);
  }

  if (params.extra) parts.push(params.extra);
  return parts.join("\n");
}

function templateDraft(promptType: AiPromptType, context: string): string {
  const header = `[${DISCLOSURE}]\n\n`;
  switch (promptType) {
    case "portfolio_summary":
      return `${header}Draft portfolio summary based on system figures only:\n${context}\n\nHuman review required before any client communication.`;
    case "risk_summary":
      return `${header}Draft risk narrative. Review open risk alerts in the Risk Monitor before relying on this text.\n${context}`;
    case "compliance_summary":
      return `${header}Draft compliance status note. Failures are not overridden by this draft.\n${context}`;
    case "research_draft":
      return `${header}Draft research note scaffold. Analyst must complete five-layer evidence before satellite use.\n${context}`;
    case "commentary_draft":
      return `${header}Draft executive commentary for report packs. Must be accepted by a human before report release.\n${context}`;
    case "rebalance_explain":
      return `${header}Draft plain-language explanation of a rebalance diff. Does not approve or execute the rebalance.\n${context}`;
    case "ticker_ideas":
      return `${header}Draft idea list only. Ideas remain subject to mandate universe, Approved List, and IPS — not trade instructions.\n${context}`;
    default:
      return `${header}${context}`;
  }
}

export async function runAiAssistant(params: {
  promptType: AiPromptType;
  portfolioId?: string;
  objectType?: string;
  objectId?: string;
  extra?: string;
  userId?: string;
}) {
  if (!ALLOWED_AI_PROMPT_TYPES.includes(params.promptType)) {
    throw Object.assign(new Error("Prompt type not allowed"), { status: 400 });
  }

  const context = await buildContext(params);
  const promptHash = hashPrompt(context);
  const gemini = await maybeGemini(
    `Produce a short professional draft for QSC IPMS (${params.promptType}). Use only this context:\n${context}`,
  );
  const body = gemini.text || templateDraft(params.promptType, context);

  const [log] = await db.insert(schema.aiGovernanceLogs).values({
    promptType: params.promptType,
    model: gemini.model,
    userId: params.userId ?? null,
    objectType: params.objectType ?? (params.portfolioId ? "portfolio" : null),
    objectId: params.objectId ?? params.portfolioId ?? null,
    promptHash,
    outputRef: body.slice(0, 2000),
    accepted: null,
    disclosure: DISCLOSURE,
  }).returning();

  await writeAudit({
    userId: params.userId,
    action: "create",
    objectType: "ai_governance_log",
    objectId: log.id,
    newValue: { promptType: params.promptType, model: gemini.model },
  });

  return {
    logId: log.id,
    promptType: params.promptType,
    model: gemini.model,
    disclosure: DISCLOSURE,
    draft: body,
    forbiddenActions: FORBIDDEN_AI_ACTIONS,
    analysisOnly: true,
  };
}

export async function setAiAcceptance(logId: string, accepted: boolean, userId?: string) {
  const [row] = await db.update(schema.aiGovernanceLogs).set({ accepted })
    .where(eq(schema.aiGovernanceLogs.id, logId)).returning();
  if (!row) throw Object.assign(new Error("Log not found"), { status: 404 });
  await writeAudit({
    userId,
    action: "update",
    objectType: "ai_governance_log",
    objectId: logId,
    newValue: { accepted },
  });
  return row;
}

export async function listAiGovernance(limit = 100) {
  return db.select().from(schema.aiGovernanceLogs)
    .orderBy(desc(schema.aiGovernanceLogs.createdAt))
    .limit(limit);
}

export function aiSystemHealth() {
  return {
    geminiConfigured: Boolean(API_KEY),
    analysisOnly: true,
    disclosure: DISCLOSURE,
    forbiddenActions: FORBIDDEN_AI_ACTIONS,
    allowedPromptTypes: ALLOWED_AI_PROMPT_TYPES,
  };
}
