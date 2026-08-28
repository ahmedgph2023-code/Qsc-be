import { db, schema } from "../db/connection.js";
import { and, asc, eq } from "drizzle-orm";
import { isSell } from "../lib/tx-type.js";

const tn = (v: unknown) => Number(v ?? 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function txDate(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}

export interface PositionState {
  quantity: number;
  totalCost: number;
}

export interface CorporateActionApplySummary {
  portfoliosAffected: number;
  totalCashPosted: number;
  totalQtyDelta: number;
  applications: Array<{
    portfolioId: string;
    qtyBefore: number;
    qtyAfter: number;
    qtyDelta: number;
    cashAmount: number;
  }>;
}

/**
 * Position in a stock for a portfolio from BUY/SELL + prior CA applications
 * with event date strictly before `beforeDate` (end of prior day entitlement).
 */
export async function getPositionBeforeDate(
  portfolioId: string,
  stockId: string,
  beforeDate: string,
  excludeCorporateActionId?: string,
): Promise<PositionState> {
  const txs = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.portfolioId, portfolioId),
        eq(schema.transactions.stockId, stockId),
      ),
    )
    .orderBy(asc(schema.transactions.timestamp));

  let quantity = 0;
  let totalCost = 0;

  for (const tx of txs) {
    if (txDate(tx.timestamp) >= beforeDate) continue;
    const qty = tn(tx.quantity);
    const price = tn(tx.price);
    if (!isSell(tx.type)) {
      quantity += qty;
      totalCost += qty * price;
    } else {
      const sellQty = Math.min(qty, quantity);
      const avg = quantity > 0 ? totalCost / quantity : 0;
      quantity -= sellQty;
      totalCost -= sellQty * avg;
    }
  }

  const appsQuery = db
    .select()
    .from(schema.corporateActionApplications)
    .where(
      and(
        eq(schema.corporateActionApplications.portfolioId, portfolioId),
        eq(schema.corporateActionApplications.stockId, stockId),
      ),
    )
    .orderBy(asc(schema.corporateActionApplications.actionDate), asc(schema.corporateActionApplications.createdAt));

  const apps = await appsQuery;
  for (const app of apps) {
    if (excludeCorporateActionId && app.corporateActionId === excludeCorporateActionId) continue;
    if (app.actionDate >= beforeDate) continue;
    // BONUS / SPLIT: qty changes, cost stays; DIVIDEND: no qty change
    quantity += tn(app.qtyDelta);
    // costAfter - costBefore should be 0 for bonus/split; keep absolute from app for safety
    totalCost += tn(app.costAfter) - tn(app.costBefore);
  }

  return {
    quantity: round4(quantity),
    totalCost: round4(Math.max(0, totalCost)),
  };
}

async function portfoliosWithAnyActivityInStock(stockId: string): Promise<string[]> {
  const fromTx = await db
    .selectDistinct({ portfolioId: schema.transactions.portfolioId })
    .from(schema.transactions)
    .where(eq(schema.transactions.stockId, stockId));
  return [...new Set(fromTx.map((r) => r.portfolioId))];
}

/** KB Cash-Dividend-Calculation-Method: eligible shares × dividend per share. */
export function cashDividendAmount(eligibleShares: number, dividendPerShare: number): number {
  return round4(eligibleShares * dividendPerShare);
}

function caEventAmount(actionType: string, cashAmount: unknown, qtyDelta: unknown): number {
  return round4(actionType === "DIVIDEND" ? tn(cashAmount) : tn(qtyDelta));
}

/** True if this client already has the same CA economic event (date + type + amount). */
async function hasDuplicateClientCaEvent(opts: {
  portfolioId: string;
  stockId: string;
  actionDate: string;
  actionType: string;
  amount: number;
}): Promise<boolean> {
  const apps = await db
    .select()
    .from(schema.corporateActionApplications)
    .where(
      and(
        eq(schema.corporateActionApplications.portfolioId, opts.portfolioId),
        eq(schema.corporateActionApplications.stockId, opts.stockId),
        eq(schema.corporateActionApplications.actionDate, opts.actionDate),
        eq(
          schema.corporateActionApplications.actionType,
          opts.actionType as "BONUS" | "STOCK_SPLIT" | "DIVIDEND" | "RIGHTS" | "CAPITAL_REDUCTION" | "MERGER_NAME_CHANGE",
        ),
      ),
    );
  return apps.some((app) => caEventAmount(app.actionType, app.cashAmount, app.qtyDelta) === opts.amount);
}

async function existingDividendCash(portfolioId: string, tradeDate: string, amount: number) {
  const rows = await db
    .select()
    .from(schema.cashTransactions)
    .where(
      and(
        eq(schema.cashTransactions.portfolioId, portfolioId),
        eq(schema.cashTransactions.tradeDate, tradeDate),
        eq(schema.cashTransactions.type, "dividend"),
      ),
    );
  return rows.find((r) => round4(tn(r.amount)) === amount) ?? null;
}

/**
 * Reverse portfolio effects of a CA: undo cash ledger, delete application rows.
 * Share quantity restores automatically once applications are removed from holdings replay.
 */
export async function reverseCorporateActionApplications(
  corporateActionId: string,
): Promise<{ reversed: number; cashReversed: number }> {
  const apps = await db
    .select()
    .from(schema.corporateActionApplications)
    .where(eq(schema.corporateActionApplications.corporateActionId, corporateActionId));

  let cashReversed = 0;

  for (const app of apps) {
    if (app.cashTransactionId) {
      const cashRows = await db
        .select()
        .from(schema.cashTransactions)
        .where(eq(schema.cashTransactions.id, app.cashTransactionId))
        .limit(1);
      if (cashRows[0]) {
        const posted = tn(cashRows[0].amount);
        const portfolios = await db
          .select()
          .from(schema.portfolios)
          .where(eq(schema.portfolios.id, app.portfolioId))
          .limit(1);
        if (portfolios[0]) {
          const newBal = round4(tn(portfolios[0].cashBalance) - posted);
          await db
            .update(schema.portfolios)
            .set({ cashBalance: String(newBal), updatedAt: new Date() })
            .where(eq(schema.portfolios.id, app.portfolioId));
          cashReversed += posted;
        }
        await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.id, app.cashTransactionId));
      }
    }
  }

  await db
    .delete(schema.corporateActionApplications)
    .where(eq(schema.corporateActionApplications.corporateActionId, corporateActionId));

  // Also clear any orphan cash txs still linked to this CA
  const orphans = await db
    .select()
    .from(schema.cashTransactions)
    .where(eq(schema.cashTransactions.corporateActionId, corporateActionId));
  for (const row of orphans) {
    const portfolios = await db
      .select()
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, row.portfolioId))
      .limit(1);
    if (portfolios[0]) {
      const posted = tn(row.amount);
      const newBal = round4(tn(portfolios[0].cashBalance) - posted);
      await db
        .update(schema.portfolios)
        .set({ cashBalance: String(newBal), updatedAt: new Date() })
        .where(eq(schema.portfolios.id, row.portfolioId));
      cashReversed += posted;
    }
    await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.id, row.id));
  }

  return { reversed: apps.length, cashReversed: round4(cashReversed) };
}

/**
 * Apply a corporate action to all entitled portfolios.
 * Call after CA row exists. Safe to re-run only after reverse.
 */
export async function applyCorporateActionToPortfolios(
  corporateActionId: string,
): Promise<CorporateActionApplySummary> {
  const cas = await db
    .select()
    .from(schema.corporateActions)
    .where(eq(schema.corporateActions.id, corporateActionId))
    .limit(1);
  if (!cas[0]) throw new Error("Corporate action not found");

  const ca = cas[0];
  if (
    ca.actionType === "RIGHTS" ||
    ca.actionType === "CAPITAL_REDUCTION" ||
    ca.actionType === "MERGER_NAME_CHANGE"
  ) {
    throw new Error(
      `CA apply for ${ca.actionType} REQUIRES BUSINESS CONFIRMATION — apply logic not implemented (audit P2 CA)`,
    );
  }

  const stockRows = await db.select().from(schema.stocks).where(eq(schema.stocks.id, ca.stockId)).limit(1);
  const stock = stockRows[0];
  if (stock && stock.instrumentType !== "equity") {
    return { portfoliosAffected: 0, totalCashPosted: 0, totalQtyDelta: 0, applications: [] };
  }

  // Ensure clean slate (idempotent apply)
  await reverseCorporateActionApplications(corporateActionId);

  const portfolioIds = await portfoliosWithAnyActivityInStock(ca.stockId);
  const summary: CorporateActionApplySummary = {
    portfoliosAffected: 0,
    totalCashPosted: 0,
    totalQtyDelta: 0,
    applications: [],
  };

  const ratio = tn(ca.ratio);
  const divPerShare = tn(ca.cashAmount);

  for (const portfolioId of portfolioIds) {
    const pos = await getPositionBeforeDate(portfolioId, ca.stockId, ca.actionDate, corporateActionId);
    if (pos.quantity <= 0.0001) continue;

    let qtyAfter = pos.quantity;
    let qtyDelta = 0;
    let costAfter = pos.totalCost;
    let cashPosted = 0;
    let cashTransactionId: string | null = null;

    if (ca.actionType === "BONUS" || ca.actionType === "STOCK_SPLIT") {
      if (!(ratio > 0)) continue;
      qtyAfter = round4(pos.quantity * ratio);
      qtyDelta = round4(qtyAfter - pos.quantity);
      costAfter = pos.totalCost; // total cost unchanged → avg cost dilutes
    } else if (ca.actionType === "DIVIDEND") {
      if (!(divPerShare > 0)) continue;
      cashPosted = cashDividendAmount(pos.quantity, divPerShare);
    }

    const eventAmount = caEventAmount(ca.actionType, cashPosted, qtyDelta);
    if (eventAmount === 0) continue;
    if (
      await hasDuplicateClientCaEvent({
        portfolioId,
        stockId: ca.stockId,
        actionDate: ca.actionDate,
        actionType: ca.actionType,
        amount: eventAmount,
      })
    ) {
      console.log(
        `[ca-portfolio] Skip duplicate ${ca.actionType} ${ca.actionDate} amount ${eventAmount} on portfolio ${portfolioId}`,
      );
      continue;
    }

    if (ca.actionType === "DIVIDEND" && cashPosted > 0) {
      const already = await existingDividendCash(portfolioId, ca.actionDate, cashPosted);
      if (already) {
        // Client already has this dividend cash (historical ledger or another CA). Do not post again.
        cashTransactionId = null;
      } else {
        const [cashTx] = await db
          .insert(schema.cashTransactions)
          .values({
            portfolioId,
            type: "dividend",
            amount: String(cashPosted),
            tradeDate: ca.actionDate,
            reference: `CA-${ca.actionType}`,
            notes: `Dividend ${divPerShare} × ${pos.quantity} shares (${stock?.ticker || ca.stockId})`,
            corporateActionId: ca.id,
          })
          .returning();
        cashTransactionId = cashTx.id;

        const portfolios = await db
          .select()
          .from(schema.portfolios)
          .where(eq(schema.portfolios.id, portfolioId))
          .limit(1);
        if (portfolios[0]) {
          const newBal = round4(tn(portfolios[0].cashBalance) + cashPosted);
          await db
            .update(schema.portfolios)
            .set({ cashBalance: String(newBal), updatedAt: new Date() })
            .where(eq(schema.portfolios.id, portfolioId));
        }
      }
    }

    try {
      await db.insert(schema.corporateActionApplications).values({
        corporateActionId: ca.id,
        portfolioId,
        stockId: ca.stockId,
        actionDate: ca.actionDate,
        actionType: ca.actionType,
        qtyBefore: String(pos.quantity),
        qtyAfter: String(qtyAfter),
        qtyDelta: String(qtyDelta),
        costBefore: String(pos.totalCost),
        costAfter: String(costAfter),
        cashAmount: String(cashPosted),
        cashTransactionId,
      });
    } catch (e: any) {
      const code = e?.cause?.code || e?.code;
      if (code === "23505" || /idx_ca_app_client_date_type_amount|idx_ca_app_unique/.test(String(e?.cause?.message || e?.message || ""))) {
        console.log(
          `[ca-portfolio] Skip duplicate ${ca.actionType} ${ca.actionDate} amount ${eventAmount} on portfolio ${portfolioId}`,
        );
        continue;
      }
      throw e;
    }

    summary.portfoliosAffected += 1;
    summary.totalCashPosted = round4(summary.totalCashPosted + (cashTransactionId ? cashPosted : 0));
    summary.totalQtyDelta = round4(summary.totalQtyDelta + qtyDelta);
    summary.applications.push({
      portfolioId,
      qtyBefore: pos.quantity,
      qtyAfter,
      qtyDelta,
      cashAmount: cashPosted,
    });
  }

  console.log(
    `[ca-portfolio] Applied ${ca.actionType} ${ca.id}: ${summary.portfoliosAffected} portfolios, cash ${summary.totalCashPosted}, qtyΔ ${summary.totalQtyDelta}`,
  );
  return summary;
}

/** Replay CA qty deltas into an aggregate map (for holdings). */
export async function loadAppliedCaDeltas(portfolioId: string) {
  return db
    .select()
    .from(schema.corporateActionApplications)
    .where(eq(schema.corporateActionApplications.portfolioId, portfolioId))
    .orderBy(asc(schema.corporateActionApplications.actionDate), asc(schema.corporateActionApplications.createdAt));
}
