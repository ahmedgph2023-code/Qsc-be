import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import {
  RESEARCH_LAYERS,
  type ApprovedListStatus,
  type ResearchLayer,
} from "../db/schema/phase3.js";
import { writeAudit } from "./audit.js";

export type SatelliteGateResult = {
  allowed: boolean;
  reasonCode?: string;
  message: string;
  layers: Array<{ layer: ResearchLayer; status: string }>;
  approvedListStatus: ApprovedListStatus | null;
  exceptionId?: string;
};

/** BUY eligibility from Approved List (Phase 3). Missing row → treat as watchlist. */
export function approvedListBuyCheck(status: ApprovedListStatus | null | undefined): {
  result: "pass" | "fail" | "warning";
  reasonCode?: string;
  message: string;
} {
  const s = status ?? "watchlist";
  if (s === "restricted") {
    return { result: "fail", reasonCode: "APPROVED_LIST_RESTRICTED", message: "Stock is Restricted on Approved List" };
  }
  if (s === "sell_only") {
    return { result: "fail", reasonCode: "APPROVED_LIST_SELL_ONLY", message: "Stock is Sell Only — new buys blocked" };
  }
  if (s === "hold") {
    return { result: "fail", reasonCode: "APPROVED_LIST_HOLD", message: "Stock is Hold — new buys restricted" };
  }
  if (s === "watchlist") {
    return { result: "warning", reasonCode: "APPROVED_LIST_WATCHLIST", message: "Stock is Watchlist — research incomplete for buys" };
  }
  return { result: "pass", message: "Approved Buy on Approved List" };
}

export async function getApprovedListStatus(stockId: string): Promise<ApprovedListStatus | null> {
  const rows = await db.select().from(schema.stockApprovedList)
    .where(eq(schema.stockApprovedList.stockId, stockId)).limit(1);
  return (rows[0]?.status as ApprovedListStatus | undefined) ?? null;
}

export async function listApprovedList(status?: string) {
  const rows = await db.select({
    id: schema.stockApprovedList.id,
    stockId: schema.stockApprovedList.stockId,
    status: schema.stockApprovedList.status,
    notes: schema.stockApprovedList.notes,
    changedAt: schema.stockApprovedList.changedAt,
    ticker: schema.stocks.ticker,
    companyName: schema.stocks.companyName,
    sector: schema.stocks.sector,
    shariahGroup: schema.stocks.shariahGroup,
  })
    .from(schema.stockApprovedList)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockApprovedList.stockId))
    .orderBy(schema.stocks.ticker);

  if (status) return rows.filter((r) => r.status === status);
  return rows;
}

export async function setApprovedListStatus(params: {
  stockId: string;
  status: ApprovedListStatus;
  notes?: string;
  userId?: string;
}) {
  const existing = await db.select().from(schema.stockApprovedList)
    .where(eq(schema.stockApprovedList.stockId, params.stockId)).limit(1);

  let row;
  if (existing[0]) {
    [row] = await db.update(schema.stockApprovedList).set({
      status: params.status,
      notes: params.notes ?? existing[0].notes,
      changedBy: params.userId ?? null,
      changedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.stockApprovedList.id, existing[0].id)).returning();
  } else {
    [row] = await db.insert(schema.stockApprovedList).values({
      stockId: params.stockId,
      status: params.status,
      notes: params.notes ?? null,
      changedBy: params.userId ?? null,
    }).returning();
  }

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "stock_approved_list",
    objectId: row.id,
    newValue: { stockId: params.stockId, status: params.status, notes: params.notes },
  });

  return row;
}

export async function getResearchLayers(stockId: string) {
  const rows = await db.select().from(schema.researchLayerAssessments)
    .where(eq(schema.researchLayerAssessments.stockId, stockId));
  const byLayer = new Map(rows.map((r) => [r.layer, r]));
  return RESEARCH_LAYERS.map((layer) => {
    const row = byLayer.get(layer);
    return row ?? {
      id: null,
      stockId,
      layer,
      status: "incomplete" as const,
      notes: null,
      analystName: null,
      assessedAt: null,
      evidenceUrl: null,
    };
  });
}

export async function upsertResearchLayer(params: {
  stockId: string;
  layer: ResearchLayer;
  status: "incomplete" | "pass" | "watch" | "fail";
  notes?: string;
  analystName?: string;
  assessedAt?: string;
  evidenceUrl?: string;
  userId?: string;
}) {
  if (!RESEARCH_LAYERS.includes(params.layer)) {
    throw Object.assign(new Error("Invalid research layer"), { status: 400 });
  }

  const existing = await db.select().from(schema.researchLayerAssessments).where(
    and(
      eq(schema.researchLayerAssessments.stockId, params.stockId),
      eq(schema.researchLayerAssessments.layer, params.layer),
    ),
  ).limit(1);

  let row;
  if (existing[0]) {
    [row] = await db.update(schema.researchLayerAssessments).set({
      status: params.status,
      notes: params.notes ?? existing[0].notes,
      analystName: params.analystName ?? existing[0].analystName,
      assessedAt: params.assessedAt ?? existing[0].assessedAt,
      evidenceUrl: params.evidenceUrl ?? existing[0].evidenceUrl,
      updatedBy: params.userId ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.researchLayerAssessments.id, existing[0].id)).returning();
  } else {
    [row] = await db.insert(schema.researchLayerAssessments).values({
      stockId: params.stockId,
      layer: params.layer,
      status: params.status,
      notes: params.notes ?? null,
      analystName: params.analystName ?? null,
      assessedAt: params.assessedAt ?? null,
      evidenceUrl: params.evidenceUrl ?? null,
      updatedBy: params.userId ?? null,
    }).returning();
  }

  await writeAudit({
    userId: params.userId,
    action: "update",
    objectType: "research_layer",
    objectId: row.id,
    newValue: { stockId: params.stockId, layer: params.layer, status: params.status },
  });

  return row;
}

export async function requestLayerException(params: {
  stockId: string;
  reason: string;
  userId?: string;
}) {
  const [row] = await db.insert(schema.researchLayerExceptions).values({
    stockId: params.stockId,
    reason: params.reason,
    requestedBy: params.userId ?? null,
  }).returning();

  await writeAudit({
    userId: params.userId,
    action: "create",
    objectType: "research_layer_exception",
    objectId: row.id,
    newValue: { stockId: params.stockId, reason: params.reason },
  });

  return row;
}

export async function approveLayerException(id: string, userId?: string) {
  const [row] = await db.update(schema.researchLayerExceptions).set({
    status: "approved",
    approvedBy: userId ?? null,
    approvedAt: new Date(),
  }).where(eq(schema.researchLayerExceptions.id, id)).returning();

  if (!row) throw Object.assign(new Error("Exception not found"), { status: 404 });

  await writeAudit({
    userId,
    action: "approve",
    objectType: "research_layer_exception",
    objectId: row.id,
    newValue: { status: "approved" },
  });

  return row;
}

/** Satellite add gate: all five layers Pass, or approved exception. */
export async function evaluateSatelliteGate(stockId: string): Promise<SatelliteGateResult> {
  const layers = await getResearchLayers(stockId);
  const approvedListStatus = await getApprovedListStatus(stockId);
  const layerSummary = layers.map((l) => ({ layer: l.layer as ResearchLayer, status: String(l.status) }));

  const exceptions = await db.select().from(schema.researchLayerExceptions).where(
    and(
      eq(schema.researchLayerExceptions.stockId, stockId),
      eq(schema.researchLayerExceptions.status, "approved"),
    ),
  ).orderBy(desc(schema.researchLayerExceptions.createdAt)).limit(1);

  if (exceptions[0]) {
    return {
      allowed: true,
      message: "Five-layer exception approved",
      layers: layerSummary,
      approvedListStatus,
      exceptionId: exceptions[0].id,
    };
  }

  const incomplete = layers.filter((l) => l.status === "incomplete");
  if (incomplete.length) {
    return {
      allowed: false,
      reasonCode: "FIVE_LAYER_INCOMPLETE",
      message: `Five-layer incomplete: ${incomplete.map((l) => l.layer).join(", ")}`,
      layers: layerSummary,
      approvedListStatus,
    };
  }

  const failed = layers.filter((l) => l.status === "fail" || l.status === "watch");
  if (failed.length) {
    return {
      allowed: false,
      reasonCode: "FIVE_LAYER_NOT_PASS",
      message: `Layers not Pass: ${failed.map((l) => `${l.layer}=${l.status}`).join(", ")}`,
      layers: layerSummary,
      approvedListStatus,
    };
  }

  const buy = approvedListBuyCheck(approvedListStatus);
  if (buy.result === "fail") {
    return {
      allowed: false,
      reasonCode: buy.reasonCode,
      message: buy.message,
      layers: layerSummary,
      approvedListStatus,
    };
  }

  return {
    allowed: true,
    message: "Five-layer Pass and Approved List allows satellite add",
    layers: layerSummary,
    approvedListStatus,
  };
}

export async function evaluateSatelliteGates(stockIds: string[]) {
  const unique = [...new Set(stockIds)];
  const results = new Map<string, SatelliteGateResult>();
  for (const id of unique) {
    results.set(id, await evaluateSatelliteGate(id));
  }
  return results;
}

export async function createShariaEsgReview(params: {
  stockId: string;
  shariahGroup?: string;
  reviewDate?: string;
  reviewerName?: string;
  evidenceNotes?: string;
  esgScore?: string | null;
  esgNotes?: string;
  syncToStock?: boolean;
  userId?: string;
}) {
  const [row] = await db.insert(schema.shariaEsgReviews).values({
    stockId: params.stockId,
    shariahGroup: params.shariahGroup ?? null,
    reviewDate: params.reviewDate ?? null,
    reviewerName: params.reviewerName ?? null,
    evidenceNotes: params.evidenceNotes ?? null,
    esgScore: params.esgScore === undefined ? null : params.esgScore,
    esgNotes: params.esgNotes ?? null,
    syncToStock: params.syncToStock ?? false,
    createdBy: params.userId ?? null,
  }).returning();

  if (params.syncToStock && params.shariahGroup) {
    await db.update(schema.stocks).set({
      shariahGroup: params.shariahGroup,
      updatedAt: new Date(),
    }).where(eq(schema.stocks.id, params.stockId));
  }

  await writeAudit({
    userId: params.userId,
    action: "create",
    objectType: "sharia_esg_review",
    objectId: row.id,
    newValue: { stockId: params.stockId, shariahGroup: params.shariahGroup, syncToStock: params.syncToStock },
  });

  return row;
}

export async function listStrategies() {
  return db.select().from(schema.investmentStrategies).orderBy(schema.investmentStrategies.modelCode);
}

export async function upsertStrategy(params: {
  id?: string;
  modelCode: string;
  title: string;
  body?: string;
  parameters?: Record<string, unknown>;
  positioningNotes?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  userId?: string;
}) {
  if (params.id) {
    const [row] = await db.update(schema.investmentStrategies).set({
      modelCode: params.modelCode,
      title: params.title,
      body: params.body ?? null,
      parameters: params.parameters ?? null,
      positioningNotes: params.positioningNotes ?? null,
      effectiveFrom: params.effectiveFrom ?? null,
      effectiveTo: params.effectiveTo ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.investmentStrategies.id, params.id)).returning();
    return row;
  }
  const [row] = await db.insert(schema.investmentStrategies).values({
    modelCode: params.modelCode,
    title: params.title,
    body: params.body ?? null,
    parameters: params.parameters ?? null,
    positioningNotes: params.positioningNotes ?? null,
    effectiveFrom: params.effectiveFrom ?? null,
    effectiveTo: params.effectiveTo ?? null,
    createdBy: params.userId ?? null,
  }).returning();
  return row;
}

export async function transitionStrategy(id: string, status: "draft" | "pending_ic" | "approved" | "retired", userId?: string) {
  const patch: Record<string, unknown> = {
    approvalStatus: status,
    updatedAt: new Date(),
  };
  if (status === "approved") {
    patch.approvedBy = userId ?? null;
    patch.approvedAt = new Date();
  }
  const [row] = await db.update(schema.investmentStrategies).set(patch)
    .where(eq(schema.investmentStrategies.id, id)).returning();
  if (!row) throw Object.assign(new Error("Strategy not found"), { status: 404 });

  await writeAudit({
    userId,
    action: "update",
    objectType: "investment_strategy",
    objectId: row.id,
    newValue: { approvalStatus: status },
  });

  return row;
}

export async function getScoreConfig() {
  const rows = await db.select().from(schema.stockScoreConfig).limit(1);
  if (rows[0]) return rows[0];
  return {
    id: null,
    name: "default",
    factors: null,
    confirmed: false,
    notes: "REQUIRES CONFIRMATION — Investment must confirm scoring factors before ranking is computed.",
  };
}

export async function listStockScores() {
  const config = await getScoreConfig();
  const scores = await db.select({
    stockId: schema.stockScores.stockId,
    score: schema.stockScores.score,
    rank: schema.stockScores.rank,
    asOf: schema.stockScores.asOf,
    ticker: schema.stocks.ticker,
    companyName: schema.stocks.companyName,
    sector: schema.stocks.sector,
  })
    .from(schema.stockScores)
    .innerJoin(schema.stocks, eq(schema.stocks.id, schema.stockScores.stockId))
    .orderBy(schema.stockScores.rank);

  return {
    config,
    scores,
    advisoryOnly: true,
    message: config.confirmed
      ? "Scores are advisory and never bypass mandate, Shariah, or IPS."
      : "Score factors not confirmed (REQUIRES CONFIRMATION). No invented weights.",
  };
}

/** Pure helper for unit tests — net-buy Approved List checks for a set of stock statuses. */
export function complianceApprovedListForBuys(
  entries: Array<{ ticker: string; isNetBuy: boolean; status: ApprovedListStatus | null }>,
) {
  const checks: Array<{ checkCode: string; result: "pass" | "fail" | "warning"; reasonCode?: string; message: string }> = [];
  for (const e of entries) {
    if (!e.isNetBuy) continue;
    const c = approvedListBuyCheck(e.status);
    checks.push({
      checkCode: "APPROVED_LIST",
      result: c.result,
      reasonCode: c.reasonCode,
      message: `${e.ticker}: ${c.message}`,
    });
  }
  if (!checks.length) {
    checks.push({ checkCode: "APPROVED_LIST", result: "pass", message: "No net buys to check" });
  }
  return checks;
}

export async function loadApprovedListMap(stockIds: string[]) {
  if (!stockIds.length) return new Map<string, ApprovedListStatus>();
  const rows = await db.select().from(schema.stockApprovedList)
    .where(inArray(schema.stockApprovedList.stockId, stockIds));
  return new Map(rows.map((r) => [r.stockId, r.status as ApprovedListStatus]));
}
