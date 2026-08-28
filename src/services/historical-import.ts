import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { defaultCouponFrequency, fiKindFromTicker, isQseFixedIncomeTicker } from "../db/debt-tickers.js";
import { writeAudit } from "./audit.js";
import {
  type SheetKind,
  inspectWorkbook,
  parseCashMatrix,
  parseClients,
  parseIndexPoints,
  parsePrices,
  parseSecurities,
  parseTrades,
  previewFromInspect,
  readWorkbook,
} from "./historical-sheet.js";
import { mapBenchmarkIndex } from "./benchmark-index.js";

const BATCH = 800;

async function insertBatches<T extends Record<string, unknown>>(
  rows: T[],
  insertFn: (batch: T[]) => Promise<unknown>,
) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await insertFn(rows.slice(i, i + BATCH));
  }
}

export function mapSectorName(code: unknown, sectorMap: Map<string, string>): string {
  const key = String(code ?? "").trim();
  if (!key) return "Equities";
  return sectorMap.get(key) || sectorMap.get(String(Number(key))) || "Equities";
}

async function recordImport(params: {
  kind: SheetKind;
  fileName: string;
  rowCount: number;
  skippedCount: number;
  customerId?: string | null;
  portfolioId?: string | null;
  clientKey?: string | null;
  summary?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const [row] = await db.insert(schema.historicalImports).values({
    kind: params.kind,
    status: "committed",
    fileName: params.fileName,
    rowCount: params.rowCount,
    skippedCount: params.skippedCount,
    customerId: params.customerId ?? null,
    portfolioId: params.portfolioId ?? null,
    clientKey: params.clientKey ?? null,
    summary: params.summary ?? null,
    createdBy: params.createdBy ?? null,
  }).returning();
  return row;
}

async function markReplaced(kind: SheetKind, customerId: string | null | undefined, newId: string) {
  const parts = [
    eq(schema.historicalImports.kind, kind),
    eq(schema.historicalImports.status, "committed"),
    ne(schema.historicalImports.id, newId),
  ];
  if (customerId) parts.push(eq(schema.historicalImports.customerId, customerId));
  await db.update(schema.historicalImports).set({
    status: "replaced",
    replacedById: newId,
  }).where(and(...parts));
}

async function ensureIndex(name: string, description: string) {
  const found = await db.select().from(schema.indices).where(eq(schema.indices.name, name)).limit(1);
  if (found[0]) return found[0];
  const [created] = await db.insert(schema.indices).values({ name, description }).returning();
  return created;
}

async function upsertStocks(entries: { ticker: string; companyName: string; sector: string }[]) {
  const existing = await db.select().from(schema.stocks);
  const byTicker = new Map(existing.map((s) => [s.ticker.toUpperCase(), s]));
  const toInsert: {
    ticker: string;
    companyName: string;
    sector: string;
    instrumentType: "equity" | "gov_bond" | "t_bill" | "sukuk" | "other_debt";
    shariahGroup: string;
    isTradable: boolean;
    regulatoryStatus: string;
  }[] = [];

  for (const s of entries) {
    const existingRow = byTicker.get(s.ticker.toUpperCase());
    const kind = fiKindFromTicker(s.ticker);
    const instrumentType = kind || "equity";
    if (!existingRow) {
      toInsert.push({
        ticker: s.ticker,
        companyName: s.companyName.slice(0, 300),
        sector: (kind ? "Fixed Income" : s.sector).slice(0, 100),
        instrumentType,
        shariahGroup: "shariah",
        isTradable: true,
        regulatoryStatus: "clear",
      });
    } else {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (!existingRow.shariahGroup) patch.shariahGroup = "shariah";
      if (kind && (existingRow as { instrumentType?: string }).instrumentType === "equity") patch.instrumentType = kind;
      if (Object.keys(patch).length > 1) {
        await db.update(schema.stocks).set(patch as any).where(eq(schema.stocks.id, existingRow.id));
      }
    }
  }

  if (toInsert.length) {
    await insertBatches(toInsert, async (batch) => {
      await db.insert(schema.stocks).values(batch).onConflictDoNothing();
    });
  }

  const stocksAfter = await db.select().from(schema.stocks);
  for (const s of stocksAfter) {
    const kind = fiKindFromTicker(s.ticker);
    if (!kind) continue;
    const [existingFi] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, s.id)).limit(1);
    if (existingFi) continue;
    await db.insert(schema.fiInstruments).values({
      stockId: s.id,
      facePar: "100",
      couponRate: "0",
      couponFrequency: defaultCouponFrequency(kind),
      dayCount: "ACT_PERIOD",
      termsComplete: false,
    });
  }
  return new Map(stocksAfter.map((s) => [s.ticker.toUpperCase(), s.id]));
}

async function resolvePortfolio(customerId: string) {
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.customerId, customerId)).limit(1);
  return portfolio ?? null;
}

async function findCustomer(opts: { customerId?: string | null; accountNumber?: string | null; email?: string | null; nin?: string | null }) {
  if (opts.customerId) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.id, opts.customerId)).limit(1);
    if (c) return c;
  }
  if (opts.accountNumber) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.accountNumber, opts.accountNumber)).limit(1);
    if (c) return c;
  }
  if (opts.email) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.email, opts.email)).limit(1);
    if (c) return c;
  }
  if (opts.nin) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.idNumber, opts.nin)).limit(1);
    if (c) return c;
  }
  return null;
}

export async function listHistoricalImports() {
  const rows = await db.select().from(schema.historicalImports).orderBy(sql`${schema.historicalImports.createdAt} desc`);
  return rows;
}

export function validateHistoricalFile(filePath: string, fileName: string, requestedKind?: SheetKind | null) {
  const wb = readWorkbook(filePath);
  const inspect = inspectWorkbook(wb, fileName, requestedKind);
  const preview = previewFromInspect(inspect);
  return {
    kind: inspect.kind,
    detectedFromFilename: inspect.fromFile,
    detectedFromHeaders: inspect.fromHeaders,
    valid: inspect.validation.ok && !!inspect.kind,
    foundKeys: inspect.validation.found,
    missingKeys: inspect.validation.missing,
    headers: preview.grid.headers.length
      ? preview.grid.headers
      : (inspect.kind === "cash" ? inspect.matrixHeaders : inspect.objectHeaders),
    parsedCount: preview.parsedCount,
    skippedCount: preview.skippedCount,
    skippedBuySell: preview.skippedBuySell,
    sample: preview.sample,
    headerIndex: preview.headerIndex,
    grid: preview.grid,
    identity: preview.identity,
    issues: preview.issues,
  };
}

export async function commitHistoricalFile(opts: {
  filePath: string;
  fileName: string;
  kind: SheetKind;
  replace?: boolean;
  customerId?: string | null;
  createdBy?: string | null;
  skipIfPopulated?: boolean;
  sectorMap?: Map<string, string>;
}) {
  const wb = readWorkbook(opts.filePath);
  const inspect = inspectWorkbook(wb, opts.fileName, opts.kind);
  if (!inspect.kind || inspect.kind !== opts.kind) {
    throw Object.assign(new Error(`Sheet type mismatch: expected ${opts.kind}, detected ${inspect.kind || "unknown"}`), { status: 400, error: "SHEET_KIND_MISMATCH" });
  }
  if (!inspect.validation.ok) {
    throw Object.assign(new Error(`Missing required keys: ${inspect.validation.missing.join(", ")}`), { status: 400, error: "MISSING_KEYS", details: inspect.validation });
  }

  if (opts.kind === "securities") {
    const parsed = parseSecurities(inspect.objects);
    const stocks = parsed.rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.companyName,
      sector: mapSectorName(r.sectorCode, opts.sectorMap || new Map()),
    }));
    await upsertStocks(stocks);
    const rec = await recordImport({
      kind: "securities", fileName: opts.fileName, rowCount: parsed.rows.length, skippedCount: parsed.skipped,
      createdBy: opts.createdBy, summary: { tickers: parsed.rows.length },
    });
    if (opts.replace) await markReplaced("securities", null, rec.id);
    return rec;
  }

  if (opts.kind === "prices") {
    if (opts.skipIfPopulated) {
      const existingPriceCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.stockPrices);
      if ((existingPriceCount[0]?.c ?? 0) > 1000) {
        return recordImport({
          kind: "prices", fileName: opts.fileName, rowCount: 0, skippedCount: 0,
          createdBy: opts.createdBy, summary: { skipped: "already_populated" },
        });
      }
    }
    const parsed = parsePrices(inspect.objects);
    const extras = parsed.rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.ticker,
      sector: fiKindFromTicker(r.ticker) ? "Fixed Income" : "Equities",
    }));
    const stockIdByTicker = await upsertStocks(extras);
    const priceInserts = parsed.rows.flatMap((r) => {
      const stockId = stockIdByTicker.get(r.ticker);
      if (!stockId) return [];
      return [{ stockId, date: r.date, price: String(r.price) }];
    });
    await insertBatches(priceInserts, async (batch) => {
      await db.insert(schema.stockPrices).values(batch).onConflictDoUpdate({
        target: [schema.stockPrices.stockId, schema.stockPrices.date],
        set: { price: sql`excluded.price` },
      });
    });
    const rec = await recordImport({
      kind: "prices", fileName: opts.fileName, rowCount: priceInserts.length, skippedCount: parsed.skipped,
      createdBy: opts.createdBy,
    });
    if (opts.replace) await markReplaced("prices", null, rec.id);
    return rec;
  }

  if (opts.kind === "indices") {
    if (opts.skipIfPopulated) {
      const idxExisting = await db.select({ c: sql<number>`count(*)::int` }).from(schema.indexDataPoints);
      if ((idxExisting[0]?.c ?? 0) > 100) {
        return recordImport({
          kind: "indices", fileName: opts.fileName, rowCount: 0, skippedCount: 0,
          createdBy: opts.createdBy, summary: { skipped: "already_populated" },
        });
      }
    }
    const qeri = await ensureIndex("QERI", "QE Al Rayan Islamic Index (Shariah benchmark)");
    const dsm = await ensureIndex("DSM", "QE General Index / DSM (unrestricted benchmark)");
    const parsed = parseIndexPoints(inspect.objects);
    const seen = new Set<string>();
    const points: { indexId: string; date: string; value: string }[] = [];
    for (const row of parsed.rows) {
      const mapped = mapBenchmarkIndex(row.code, row.name);
      const target = mapped === "QERI" ? qeri : mapped === "DSM" ? dsm : null;
      if (!target) continue;
      const key = `${target.id}|${row.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ indexId: target.id, date: row.date, value: String(row.value) });
    }
    await insertBatches(points, async (batch) => {
      await db.insert(schema.indexDataPoints).values(batch).onConflictDoUpdate({
        target: [schema.indexDataPoints.indexId, schema.indexDataPoints.date],
        set: { value: sql`excluded.value` },
      });
    });
    const rec = await recordImport({
      kind: "indices", fileName: opts.fileName, rowCount: points.length, skippedCount: parsed.skipped,
      createdBy: opts.createdBy, summary: { qeriId: qeri.id, dsmId: dsm.id },
    });
    if (opts.replace) await markReplaced("indices", null, rec.id);
    return rec;
  }

  if (opts.kind === "client") {
    const parsed = parseClients(inspect.objects);
    if (!parsed.rows.length) throw Object.assign(new Error("No client rows in sheet"), { status: 400, error: "EMPTY_CLIENT_SHEET" });
    const dsm = await ensureIndex("DSM", "QE General Index / DSM (unrestricted benchmark)");
    const created: { customerId: string; portfolioId: string; accountNumber: string }[] = [];
    for (const c of parsed.rows) {
      let customer = await findCustomer({
        accountNumber: c.accountNumber || null,
        email: c.email,
        nin: c.nin || null,
      });
      if (!customer) {
        const [row] = await db.insert(schema.customers).values({
          name: c.name.slice(0, 300),
          email: c.email,
          joinDate: c.joinDate,
          accountNumber: c.accountNumber || null,
          idNumber: c.nin || null,
          notes: c.notes,
        }).returning();
        customer = row;
      } else if (opts.replace) {
        const [row] = await db.update(schema.customers).set({
          name: c.name.slice(0, 300),
          email: c.email,
          joinDate: c.joinDate,
          accountNumber: c.accountNumber || customer.accountNumber,
          idNumber: c.nin || customer.idNumber,
          notes: c.notes,
        }).where(eq(schema.customers.id, customer.id)).returning();
        customer = row;
      }
      let portfolio = await resolvePortfolio(customer.id);
      if (!portfolio) {
        const [p] = await db.insert(schema.portfolios).values({
          customerId: customer.id,
          name: `${customer.name} Portfolio`,
          benchmarkIndexId: dsm.id,
          inceptionDate: c.joinDate,
          cashBalance: "0",
          status: "active",
        }).returning();
        portfolio = p;
      }
      created.push({ customerId: customer.id, portfolioId: portfolio.id, accountNumber: c.accountNumber });
    }
    const primary = created[0];
    const rec = await recordImport({
      kind: "client",
      fileName: opts.fileName,
      rowCount: parsed.rows.length,
      skippedCount: parsed.skipped,
      customerId: primary.customerId,
      portfolioId: primary.portfolioId,
      clientKey: primary.accountNumber,
      createdBy: opts.createdBy,
      summary: { clients: created },
    });
    if (opts.replace) await markReplaced("client", primary.customerId, rec.id);
    return rec;
  }

  const customer = await findCustomer({ customerId: opts.customerId || null });
  if (!customer) {
    throw Object.assign(new Error("Select or import a client before loading trades or cash"), { status: 400, error: "CLIENT_REQUIRED" });
  }
  let portfolio = await resolvePortfolio(customer.id);
  if (!portfolio) {
    const dsm = await ensureIndex("DSM", "QE General Index / DSM (unrestricted benchmark)");
    const [p] = await db.insert(schema.portfolios).values({
      customerId: customer.id,
      name: `${customer.name} Portfolio`,
      benchmarkIndexId: dsm.id,
      cashBalance: "0",
      status: "active",
    }).returning();
    portfolio = p;
  }

  if (opts.kind === "trades") {
    if (opts.skipIfPopulated) {
      const txCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.transactions)
        .where(eq(schema.transactions.portfolioId, portfolio.id));
      if ((txCount[0]?.c ?? 0) > 0) {
        return recordImport({
          kind: "trades", fileName: opts.fileName, rowCount: 0, skippedCount: 0,
          customerId: customer.id, portfolioId: portfolio.id,
          createdBy: opts.createdBy, summary: { skipped: "already_populated" },
        });
      }
    }
    if (opts.replace) {
      await db.delete(schema.transactions).where(eq(schema.transactions.portfolioId, portfolio.id));
    }
    const parsed = parseTrades(inspect.objects);
    const extras = parsed.rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.ticker,
      sector: isQseFixedIncomeTicker(r.ticker) ? "Fixed Income" : "Equities",
    }));
    const stockIdByTicker = await upsertStocks(extras);
    const rec = await recordImport({
      kind: "trades",
      fileName: opts.fileName,
      rowCount: 0,
      skippedCount: parsed.skipped,
      customerId: customer.id,
      portfolioId: portfolio.id,
      clientKey: customer.accountNumber,
      createdBy: opts.createdBy,
    });
    const txRows = parsed.rows.flatMap((r) => {
      const stockId = stockIdByTicker.get(r.ticker.toUpperCase());
      if (!stockId) return [];
      return [{
        portfolioId: portfolio.id,
        stockId,
        type: r.type,
        quantity: String(r.qty),
        price: String(r.price),
        timestamp: new Date(`${r.date}T00:00:00.000Z`),
        notes: r.notes,
        sourceImportId: rec.id,
      }];
    });
    await insertBatches(txRows, async (batch) => {
      await db.insert(schema.transactions).values(batch);
    });
    const [updated] = await db.update(schema.historicalImports).set({
      rowCount: txRows.length,
      summary: { inserted: txRows.length },
    }).where(eq(schema.historicalImports.id, rec.id)).returning();
    if (opts.replace) await markReplaced("trades", customer.id, rec.id);
    return updated || rec;
  }

  if (opts.skipIfPopulated) {
    const cashCount = await db.select({ c: sql<number>`count(*)::int` }).from(schema.cashTransactions)
      .where(eq(schema.cashTransactions.portfolioId, portfolio.id));
    if ((cashCount[0]?.c ?? 0) > 0) {
      return recordImport({
        kind: "cash", fileName: opts.fileName, rowCount: 0, skippedCount: 0,
        customerId: customer.id, portfolioId: portfolio.id,
        createdBy: opts.createdBy, summary: { skipped: "already_populated" },
      });
    }
  }
  if (opts.replace) {
    await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.portfolioId, portfolio.id));
  }
  const parsed = parseCashMatrix(inspect.matrix);
  const rec = await recordImport({
    kind: "cash",
    fileName: opts.fileName,
    rowCount: 0,
    skippedCount: parsed.skipped,
    customerId: customer.id,
    portfolioId: portfolio.id,
    clientKey: customer.accountNumber,
    createdBy: opts.createdBy,
    summary: { headerIndex: parsed.headerIndex },
  });
  const cashRows = parsed.rows.map((r) => ({
    portfolioId: portfolio.id,
    type: r.type,
    amount: String(r.amount),
    tradeDate: r.tradeDate,
    reference: r.reference,
    notes: r.notes,
    sourceImportId: rec.id,
  }));
  await insertBatches(cashRows, async (batch) => {
    await db.insert(schema.cashTransactions).values(batch);
  });
  const [updated] = await db.update(schema.historicalImports).set({
    rowCount: cashRows.length,
    summary: { inserted: cashRows.length, headerIndex: parsed.headerIndex },
  }).where(eq(schema.historicalImports.id, rec.id)).returning();
  if (opts.replace) await markReplaced("cash", customer.id, rec.id);
  return updated || rec;
}

export async function deleteHistoricalImport(id: string, actorId?: string | null) {
  const [row] = await db.select().from(schema.historicalImports).where(eq(schema.historicalImports.id, id)).limit(1);
  if (!row) throw Object.assign(new Error("Import not found"), { status: 404, error: "NOT_FOUND" });
  if (row.status === "deleted") return row;

  if (row.kind === "trades" && row.portfolioId) {
    if (row.id) {
      await db.delete(schema.transactions).where(eq(schema.transactions.sourceImportId, row.id));
    }
  } else if (row.kind === "cash" && row.portfolioId) {
    await db.delete(schema.cashTransactions).where(eq(schema.cashTransactions.sourceImportId, row.id));
  }

  const [updated] = await db.update(schema.historicalImports).set({ status: "deleted" }).where(eq(schema.historicalImports.id, id)).returning();
  await writeAudit({
    userId: actorId,
    action: "delete",
    objectType: "historical_import",
    objectId: id,
    oldValue: { kind: row.kind, rowCount: row.rowCount },
    newValue: { status: "deleted" },
  });
  return updated;
}

export async function importHistoricalPackage(opts: {
  securitiesPath?: string | null;
  pricesPath?: string | null;
  indexPath?: string | null;
  clientPath?: string | null;
  tradesPath?: string | null;
  cashPath?: string | null;
  skipIfPopulated?: boolean;
  createdBy?: string | null;
  sectorMap?: Map<string, string>;
}) {
  let customerId: string | null = null;
  const run = async (kind: SheetKind, filePath: string | null | undefined) => {
    if (!filePath) return null;
    const fileName = filePath.split(/[/\\]/).pop() || kind;
    return commitHistoricalFile({
      filePath,
      fileName,
      kind,
      replace: false,
      customerId,
      createdBy: opts.createdBy,
      skipIfPopulated: opts.skipIfPopulated,
      sectorMap: opts.sectorMap,
    });
  };

  await run("securities", opts.securitiesPath);
  await run("prices", opts.pricesPath);
  await run("indices", opts.indexPath);
  const client = await run("client", opts.clientPath);
  customerId = client?.customerId || null;
  await run("trades", opts.tradesPath);
  await run("cash", opts.cashPath);
  return { customerId, portfolioId: client?.portfolioId || null };
}

export async function applyEndingCash(portfolioId: string, amount: number) {
  await db.update(schema.portfolios).set({
    cashBalance: String(amount),
    updatedAt: new Date(),
  }).where(eq(schema.portfolios.id, portfolioId));
}
