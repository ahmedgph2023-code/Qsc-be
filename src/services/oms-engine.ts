import { db, schema } from "../db/connection.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { executeStockTrade } from "./trade-cash.js";
import { runCompliance } from "./compliance-engine.js";
import { writeAudit } from "./audit.js";
import { assertMandateAllowsTrading } from "./mandate-rules.js";

function n(v: unknown) {
  return Number(v ?? 0);
}

function round4(x: number) {
  return Math.round(x * 10000) / 10000;
}

async function requireApprovedMandate(portfolioId: string) {
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  if (!portfolio) throw Object.assign(new Error("Portfolio not found"), { status: 404 });
  const gate = await assertMandateAllowsTrading(portfolio.customerId);
  if (!gate.ok) throw Object.assign(new Error(gate.error || "Mandate not approved"), { status: 403, code: "MANDATE_NOT_APPROVED" });
  return portfolio;
}

export async function listOrders(filters?: { portfolioId?: string; status?: string }) {
  const rows = await db.select().from(schema.omsOrders).orderBy(desc(schema.omsOrders.createdAt));
  return rows.filter((r) => {
    if (filters?.portfolioId && r.portfolioId !== filters.portfolioId) return false;
    if (filters?.status && r.status !== filters.status) return false;
    return true;
  });
}

export async function createOrder(input: {
  portfolioId: string;
  stockId: string;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice?: number | null;
  broker?: string | null;
  reason?: string | null;
  rebalanceId?: string | null;
  createdBy?: string | null;
}) {
  await requireApprovedMandate(input.portfolioId);
  const qty = n(input.quantity);
  if (!(qty > 0)) throw Object.assign(new Error("quantity must be positive"), { status: 400 });

  const [row] = await db.insert(schema.omsOrders).values({
    portfolioId: input.portfolioId,
    stockId: input.stockId,
    side: input.side,
    quantity: String(qty),
    limitPrice: input.limitPrice != null ? String(input.limitPrice) : null,
    broker: input.broker ?? null,
    reason: input.reason ?? null,
    rebalanceId: input.rebalanceId ?? null,
    status: "draft",
    createdBy: input.createdBy ?? null,
  }).returning();

  await writeAudit({
    userId: input.createdBy ?? null,
    action: "create",
    objectType: "oms_order",
    objectId: row.id,
    newValue: row,
  });
  return row;
}

export async function transitionOrder(orderId: string, status: typeof schema.omsOrders.$inferSelect["status"], actorId?: string) {
  const [order] = await db.select().from(schema.omsOrders).where(eq(schema.omsOrders.id, orderId)).limit(1);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });

  const allowed: Record<string, string[]> = {
    draft: ["approved", "cancelled", "rejected"],
    approved: ["sent", "cancelled"],
    sent: ["partial", "filled", "cancelled"],
    partial: ["filled", "cancelled"],
  };
  const next = allowed[order.status] ?? [];
  if (!next.includes(status)) {
    throw Object.assign(new Error(`Cannot move ${order.status} → ${status}`), { status: 400 });
  }

  const patch: Partial<typeof schema.omsOrders.$inferInsert> = {
    status,
    updatedAt: new Date(),
  };
  if (status === "approved") {
    patch.approvedBy = actorId ?? null;
    patch.approvedAt = new Date();
  }

  const [updated] = await db.update(schema.omsOrders).set(patch).where(eq(schema.omsOrders.id, orderId)).returning();
  await writeAudit({
    userId: actorId ?? null,
    action: "status_change",
    objectType: "oms_order",
    objectId: orderId,
    oldValue: { status: order.status },
    newValue: { status },
  });
  return updated;
}

export async function recordFill(input: {
  orderId: string;
  fillQty: number;
  fillPrice: number;
  commission?: number;
  notes?: string;
  createdBy?: string;
  skipPriceRange?: boolean;
}) {
  const [order] = await db.select().from(schema.omsOrders).where(eq(schema.omsOrders.id, input.orderId)).limit(1);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!["approved", "sent", "partial"].includes(order.status)) {
    throw Object.assign(new Error("Order must be approved/sent/partial to fill"), { status: 400 });
  }

  const fillQty = n(input.fillQty);
  const fillPrice = n(input.fillPrice);
  if (!(fillQty > 0) || !(fillPrice > 0)) throw Object.assign(new Error("fillQty and fillPrice required"), { status: 400 });

  const already = n(order.filledQuantity);
  const target = n(order.quantity);
  if (already + fillQty > target + 0.0001) {
    throw Object.assign(new Error("Fill exceeds remaining quantity"), { status: 400 });
  }

  const trade = await executeStockTrade({
    portfolioId: order.portfolioId,
    stockId: order.stockId,
    type: order.side,
    quantity: fillQty,
    price: fillPrice,
    timestamp: new Date(),
    skipPriceRange: input.skipPriceRange ?? true,
  });

  const commission = n(input.commission ?? 0);
  const [fill] = await db.insert(schema.omsFills).values({
    orderId: order.id,
    fillQty: String(fillQty),
    fillPrice: String(fillPrice),
    commission: String(commission),
    transactionId: trade.transaction.id,
    notes: input.notes ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();

  const newFilled = round4(already + fillQty);
  const avg = already <= 0
    ? fillPrice
    : round4(((n(order.avgFillPrice) || 0) * already + fillPrice * fillQty) / newFilled);
  const status = newFilled + 0.0001 >= target ? "filled" : "partial";

  const [updated] = await db.update(schema.omsOrders).set({
    filledQuantity: String(newFilled),
    avgFillPrice: String(avg),
    commission: String(round4(n(order.commission) + commission)),
    status,
    updatedAt: new Date(),
  }).where(eq(schema.omsOrders.id, order.id)).returning();

  const compliance = await runCompliance({
    portfolioId: order.portfolioId,
    timing: "after_trade",
    persist: true,
  });

  await writeAudit({
    userId: input.createdBy ?? null,
    action: "update",
    objectType: "oms_fill",
    objectId: fill.id,
    newValue: { fill, orderStatus: status, compliancePassed: compliance.passed },
  });

  return { order: updated, fill, trade, compliance };
}

export function allocateProRata(legs: Array<{ orderId: string; quantity: number }>, fillQty: number) {
  const total = legs.reduce((s, l) => s + l.quantity, 0);
  if (!(total > 0) || !(fillQty > 0)) return legs.map((l) => ({ orderId: l.orderId, allocQty: 0 }));
  let remaining = fillQty;
  return legs.map((l, i) => {
    if (i === legs.length - 1) {
      const allocQty = round4(remaining);
      remaining = 0;
      return { orderId: l.orderId, allocQty };
    }
    const allocQty = round4((l.quantity / total) * fillQty);
    remaining = round4(remaining - allocQty);
    return { orderId: l.orderId, allocQty };
  });
}

export async function createBlockGroup(input: {
  stockId: string;
  side: "BUY" | "SELL";
  orderIds: string[];
  allocationMethod?: "pro_rata" | "model_based" | "cash_based" | "exception";
  exceptionReason?: string;
  createdBy?: string;
}) {
  if (!input.orderIds.length) throw Object.assign(new Error("orderIds required"), { status: 400 });
  const orders = await db.select().from(schema.omsOrders).where(inArray(schema.omsOrders.id, input.orderIds));
  if (orders.length !== input.orderIds.length) throw Object.assign(new Error("Some orders not found"), { status: 404 });
  for (const o of orders) {
    if (o.stockId !== input.stockId || o.side !== input.side) {
      throw Object.assign(new Error("All orders must share stock and side"), { status: 400 });
    }
  }
  if (input.allocationMethod === "exception" && !input.exceptionReason) {
    throw Object.assign(new Error("exceptionReason required for exception allocation"), { status: 400 });
  }

  const [block] = await db.insert(schema.omsBlockGroups).values({
    stockId: input.stockId,
    side: input.side,
    allocationMethod: input.allocationMethod ?? "pro_rata",
    exceptionReason: input.exceptionReason ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();

  await db.update(schema.omsOrders)
    .set({ blockGroupId: block.id, updatedAt: new Date() })
    .where(inArray(schema.omsOrders.id, input.orderIds));

  await writeAudit({
    userId: input.createdBy ?? null,
    action: "create",
    objectType: "oms_block_group",
    objectId: block.id,
    newValue: { block, orderIds: input.orderIds },
  });
  return block;
}

export async function fillBlockProRata(input: {
  blockGroupId: string;
  fillQty: number;
  fillPrice: number;
  createdBy?: string;
}) {
  const [block] = await db.select().from(schema.omsBlockGroups).where(eq(schema.omsBlockGroups.id, input.blockGroupId)).limit(1);
  if (!block) throw Object.assign(new Error("Block not found"), { status: 404 });
  const orders = await db.select().from(schema.omsOrders).where(and(
    eq(schema.omsOrders.blockGroupId, input.blockGroupId),
    inArray(schema.omsOrders.status, ["approved", "sent", "partial"]),
  ));
  if (!orders.length) throw Object.assign(new Error("No fillable orders in block"), { status: 400 });

  const allocs = allocateProRata(
    orders.map((o) => ({ orderId: o.id, quantity: Math.max(0, n(o.quantity) - n(o.filledQuantity)) })),
    n(input.fillQty),
  );

  const results = [];
  for (const a of allocs) {
    if (a.allocQty <= 0.0001) continue;
    results.push(await recordFill({
      orderId: a.orderId,
      fillQty: a.allocQty,
      fillPrice: n(input.fillPrice),
      createdBy: input.createdBy,
      skipPriceRange: true,
    }));
  }
  return { block, allocations: allocs, results };
}
