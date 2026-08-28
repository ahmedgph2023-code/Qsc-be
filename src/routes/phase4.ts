import { Router } from "express";
import { authMiddleware, requireRole, type AuthRequest } from "../middleware/auth.js";
import {
  aiSystemHealth, listAiGovernance, runAiAssistant, setAiAcceptance,
} from "../services/ai-assistant.js";
import {
  generateCommentaryDraft, listCommentaryDrafts, reviewCommentary,
} from "../services/commentary-engine.js";
import { listScenarios, runScenario } from "../services/scenario-engine.js";
import { listFrontierRuns, runEfficientFrontier } from "../services/efficient-frontier.js";
import type { AiPromptType } from "../db/schema/phase4.js";

function paramId(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

export const aiRouter = Router();
aiRouter.use(authMiddleware);

aiRouter.get("/health", requireRole("admin", "pm", "approver", "compliance", "viewer"), (_req, res) => {
  res.json(aiSystemHealth());
});

aiRouter.get("/governance", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  res.json({ data: await listAiGovernance() });
});

aiRouter.post("/assist", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const promptType = req.body?.promptType as AiPromptType;
    if (!promptType) {
      res.status(400).json({ error: "promptType required" });
      return;
    }
    const out = await runAiAssistant({
      promptType,
      portfolioId: req.body?.portfolioId,
      objectType: req.body?.objectType,
      objectId: req.body?.objectId,
      extra: req.body?.extra,
      userId: req.adminId,
    });
    res.json(out);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Assist failed" });
  }
});

aiRouter.post("/governance/:id/accept", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const accepted = req.body?.accepted !== false;
    res.json(await setAiAcceptance(paramId(req.params.id), accepted, req.adminId));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

export const commentaryRouter = Router();
commentaryRouter.use(authMiddleware);

commentaryRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (_req, res) => {
  res.json({ data: await listCommentaryDrafts() });
});

commentaryRouter.post("/generate", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const kind = String(req.body?.kind || "aum_monthly");
    const out = await generateCommentaryDraft({
      kind,
      periodLabel: req.body?.periodLabel,
      portfolioId: req.body?.portfolioId,
      reportReleaseId: req.body?.reportReleaseId,
      userId: req.adminId,
    });
    res.status(201).json(out);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Generate failed" });
  }
});

commentaryRouter.post("/:id/review", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const status = req.body?.status as "accepted" | "rejected" | "edited" | "released";
    res.json(await reviewCommentary({
      id: paramId(req.params.id),
      status,
      body: req.body?.body,
      userId: req.adminId,
    }));
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Review failed" });
  }
});

export const scenariosRouter = Router();
scenariosRouter.use(authMiddleware);

scenariosRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  const portfolioId = typeof req.query.portfolioId === "string" ? req.query.portfolioId : undefined;
  res.json({ data: await listScenarios(portfolioId) });
});

scenariosRouter.post("/run", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    const out = await runScenario({
      kind: req.body?.kind,
      portfolioId: req.body?.portfolioId,
      name: req.body?.name,
      legs: req.body?.legs,
      shockPct: req.body?.shockPct != null ? Number(req.body.shockPct) : undefined,
      stockIds: req.body?.stockIds,
      sector: req.body?.sector,
      persist: req.body?.persist !== false,
      userId: req.adminId,
    });
    res.status(201).json(out);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Scenario failed" });
  }
});

export const frontierRouter = Router();
frontierRouter.use(authMiddleware);

frontierRouter.get("/", requireRole("admin", "pm", "approver", "compliance", "viewer"), async (req, res) => {
  const portfolioId = typeof req.query.portfolioId === "string" ? req.query.portfolioId : undefined;
  res.json({ data: await listFrontierRuns(portfolioId) });
});

frontierRouter.post("/run", requireRole("admin", "pm", "approver"), async (req: AuthRequest, res) => {
  try {
    if (!req.body?.portfolioId) {
      res.status(400).json({ error: "portfolioId required" });
      return;
    }
    const out = await runEfficientFrontier({
      portfolioId: req.body.portfolioId,
      maxNames: req.body?.maxNames != null ? Number(req.body.maxNames) : undefined,
      userId: req.adminId,
    });
    res.status(201).json(out);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Frontier failed" });
  }
});
