import "dotenv/config";
import XLSX from "xlsx";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./connection.js";
import { isQseFixedIncomeTicker, fiKindFromTicker, defaultCouponFrequency } from "./debt-tickers.js";
import { upsertFiInstrumentForStock, createLotFromBuyTransaction } from "../services/fixed-income/daily-pnl-engine.js";

/**
 * Seeds FI market instruments from CB_PRICES and opens a demo FI lot
 * for client سعد احمد ابراهيم الحسن المهندى.
 *
 * Note: historical portfolio/trades for this client contain equities only.
 * This demo lot is illustrative so FI daily P&L can be exercised.
 */

const CLIENT_NAME = "سعد احمد ابراهيم الحسن المهندى";
const DEMO_TICKER = "GA11";
const DEMO_FACE_UNITS = 1000; // 1000 × 100 par = QAR 100,000 face
const DEMO_COUPON = 0.045; // 4.5% annual, semi-annual
const DEMO_PURCHASE = "2024-01-15";

function excelDateToIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(v));
    return epoch.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/) || s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  if (m[0].includes("-")) return `${m[1]}-${m[2]}-${m[3]}`;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

async function main() {
  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.name, CLIENT_NAME)).limit(1);
  if (!customer) throw new Error(`Customer not found: ${CLIENT_NAME}`);
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.customerId, customer.id)).limit(1);
  if (!portfolio) throw new Error("Portfolio not found");

  // Ensure mandate approved so trading isn't blocked later
  const [mandate] = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, customer.id)).limit(1);
  if (mandate && mandate.approvalStatus !== "approved") {
    await db.update(schema.mandates).set({ approvalStatus: "approved", updatedAt: new Date() }).where(eq(schema.mandates.id, mandate.id));
    console.log("[fi-seed] Mandate set to approved");
  }

  const pricesPath = "historical-data/37808/اسعار اغلاق الشركات/CB_PRICES.xls";
  const wb = XLSX.readFile(pricesPath);
  const allPriceRows: any[] = [];
  for (const name of wb.SheetNames) {
    allPriceRows.push(...XLSX.utils.sheet_to_json(wb.Sheets[name]));
  }

  const byTicker = new Map<string, { date: string; price: number }[]>();
  for (const row of allPriceRows) {
    const ticker = String(row.TICKER_ID || "").trim().toUpperCase();
    if (!isQseFixedIncomeTicker(ticker)) continue;
    const date = excelDateToIso(row.PR_PRICE_DATE);
    const price = Number(row.PR_C_PRICE ?? row.PR_SHARE_PRICE);
    if (!date || !Number.isFinite(price) || price <= 0) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker)!.push({ date, price });
  }
  console.log(`[fi-seed] FI tickers in price file: ${byTicker.size}`);

  // Upsert FI stocks + prices (cap to keep seed fast — all tickers, prices batched)
  let stockCount = 0;
  let priceCount = 0;
  for (const [ticker, pts] of byTicker) {
    const kind = fiKindFromTicker(ticker)!;
    let [stock] = await db.select().from(schema.stocks).where(eq(schema.stocks.ticker, ticker)).limit(1);
    if (!stock) {
      [stock] = await db.insert(schema.stocks).values({
        ticker,
        companyName: `${ticker} Fixed Income`,
        sector: "Fixed Income",
        instrumentType: kind,
        shariahGroup: "shariah",
        isTradable: true,
        regulatoryStatus: "clear",
      }).returning();
      stockCount++;
    } else if (stock.instrumentType === "equity") {
      await db.update(schema.stocks).set({ instrumentType: kind, sector: "Fixed Income", updatedAt: new Date() }).where(eq(schema.stocks.id, stock.id));
    }

    const [fi] = await db.select().from(schema.fiInstruments).where(eq(schema.fiInstruments.stockId, stock.id)).limit(1);
    if (!fi) {
      await db.insert(schema.fiInstruments).values({
        stockId: stock.id,
        facePar: "100",
        couponRate: kind === "t_bill" ? "0" : "0",
        couponFrequency: defaultCouponFrequency(kind),
        dayCount: "ACT_PERIOD",
        termsComplete: false,
      });
    }

    // insert prices
    const seen = new Set<string>();
    const batch: { stockId: string; date: string; price: string }[] = [];
    for (const p of pts) {
      const key = `${p.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push({ stockId: stock.id, date: p.date, price: String(p.price) });
    }
    for (let i = 0; i < batch.length; i += 500) {
      await db.insert(schema.stockPrices).values(batch.slice(i, i + 500)).onConflictDoNothing();
      priceCount += Math.min(500, batch.length - i);
    }
  }
  console.log(`[fi-seed] new stocks ${stockCount}, price rows attempted ~${priceCount}`);

  // Demo instrument terms for GA11
  let [demoStock] = await db.select().from(schema.stocks).where(eq(schema.stocks.ticker, DEMO_TICKER)).limit(1);
  if (!demoStock) {
    // fallback first GA*
    const [anyGa] = await db.select().from(schema.stocks).where(sql`ticker like 'GA%' and instrument_type <> 'equity'`).limit(1);
    if (!anyGa) throw new Error("No GA government bond ticker found in price file");
    demoStock = anyGa;
    console.log(`[fi-seed] ${DEMO_TICKER} missing — using ${demoStock.ticker}`);
  }

  const pts = byTicker.get(demoStock.ticker) || [];
  pts.sort((a, b) => a.date.localeCompare(b.date));
  const first = pts[0]?.date || "2023-01-01";
  const last = pts[pts.length - 1]?.date || "2026-12-31";
  // maturity ~ 2y after last price or fixed
  const maturity = "2027-01-15";
  const issue = first < "2023-01-15" ? first : "2023-01-15";

  await upsertFiInstrumentForStock(demoStock.id, {
    facePar: 100,
    couponRate: DEMO_COUPON,
    couponFrequency: "semi_annual",
    dayCount: "ACT_PERIOD",
    issueDate: issue,
    maturityDate: maturity,
    shariahNotes: "Demo terms for client FI daily P&L (not from historical holdings export)",
  });
  console.log(`[fi-seed] Terms set for ${demoStock.ticker}: ${DEMO_COUPON * 100}% semi-annual ${issue}→${maturity}`);

  // Purchase price on/before DEMO_PURCHASE
  const px = [...pts].reverse().find((p) => p.date <= DEMO_PURCHASE) || pts[0];
  const purchasePrice = px?.price ?? 100;

  // Avoid duplicate demo lots
  const existingLots = await db.select().from(schema.fiLots).where(and(
    eq(schema.fiLots.portfolioId, portfolio.id),
    eq(schema.fiLots.stockId, demoStock.id),
  ));
  if (existingLots.length) {
    console.log(`[fi-seed] Lot already exists for ${demoStock.ticker} (${existingLots.length}) — rebuilding daily PnL`);
    const { rebuildLotDailyPnl } = await import("../services/fixed-income/daily-pnl-engine.js");
    for (const lot of existingLots) await rebuildLotDailyPnl(lot.id);
  } else {
    const [tx] = await db.insert(schema.transactions).values({
      portfolioId: portfolio.id,
      stockId: demoStock.id,
      type: "BUY",
      quantity: String(DEMO_FACE_UNITS),
      price: String(purchasePrice),
      timestamp: new Date(`${DEMO_PURCHASE}T10:00:00.000Z`),
      notes: "Demo FI seed — historical export had no FI holdings for this client",
    }).returning();
    const lot = await createLotFromBuyTransaction(tx.id);
    console.log(`[fi-seed] Created BUY ${DEMO_FACE_UNITS} × ${demoStock.ticker} @ ${purchasePrice} on ${DEMO_PURCHASE}`);
    console.log(`[fi-seed] Lot ${lot.id} daily PnL generated`);
  }

  console.log(`[fi-seed] Done for ${CLIENT_NAME} / portfolio ${portfolio.id}`);
  console.log(`[fi-seed] Open Fixed Income → ${demoStock.ticker} or client FI lots panel`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[fi-seed] FAILED", e);
  process.exit(1);
});
