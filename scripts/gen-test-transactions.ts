import "dotenv/config";
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://qse:qse_password@localhost:5433/qse";
}

const { db, schema } = await import("../src/db/connection.js");
const { asc, desc, eq, inArray } = await import("drizzle-orm");
const XLSX = (await import("xlsx")).default;
const path = await import("path");
const { fileURLToPath } = await import("url");
const { allowedGroups, normalizeShariahGroup } = await import("../src/services/mandate-rules.js");
type ShariahPreference = "fully_shariah" | "unrestricted";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const customers = await db.select().from(schema.customers).orderBy(asc(schema.customers.name)).limit(20);
  console.log("CUSTOMERS", customers.map((c) => ({ id: c.id, name: c.name })));

  let chosen: {
    customerId: string;
    customerName: string;
    portfolioId: string;
    shariah: ShariahPreference;
    status: string;
    restrictions: { type: string; stockId: string | null; sector: string | null }[];
  } | null = null;

  for (const c of customers) {
    const [m] = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, c.id)).limit(1);
    const [p] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.customerId, c.id)).limit(1);
    if (!m || !p) continue;
    const restrictions = await db
      .select()
      .from(schema.mandateRestrictions)
      .where(eq(schema.mandateRestrictions.mandateId, m.id));
    const info = {
      customerId: c.id,
      customerName: c.name,
      portfolioId: p.id,
      shariah: m.shariahPreference as ShariahPreference,
      status: m.approvalStatus,
      cash: p.cashBalance,
      restrictions: restrictions.map((r) => ({
        type: r.restrictionType,
        stockId: r.stockId,
        sector: r.sector,
        active: r.isActive,
      })),
    };
    console.log("MANDATE", JSON.stringify(info, null, 2));
    if (!chosen && m.approvalStatus === "approved") {
      chosen = {
        customerId: c.id,
        customerName: c.name,
        portfolioId: p.id,
        shariah: m.shariahPreference as ShariahPreference,
        status: m.approvalStatus,
        restrictions: restrictions
          .filter((r) => r.isActive)
          .map((r) => ({ type: r.restrictionType, stockId: r.stockId, sector: r.sector })),
      };
    }
  }

  if (!chosen) {
    for (const c of customers) {
      const [m] = await db.select().from(schema.mandates).where(eq(schema.mandates.customerId, c.id)).limit(1);
      const [p] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.customerId, c.id)).limit(1);
      if (m && p) {
        chosen = {
          customerId: c.id,
          customerName: c.name,
          portfolioId: p.id,
          shariah: m.shariahPreference as ShariahPreference,
          status: m.approvalStatus,
          restrictions: [],
        };
        break;
      }
    }
  }

  if (!chosen) throw new Error("No client with mandate+portfolio found");
  console.log("CHOSEN", chosen);

  const groups = allowedGroups(chosen.shariah);
  const restrictedStockIds = new Set(
    chosen.restrictions.filter((r) => r.type === "stock" && r.stockId).map((r) => r.stockId!),
  );
  const restrictedSectors = new Set(
    chosen.restrictions
      .filter((r) => r.type === "sector" && r.sector)
      .map((r) => r.sector!.toLowerCase()),
  );

  const stocks = await db.select().from(schema.stocks).orderBy(asc(schema.stocks.ticker));
  const first3 = stocks.slice(0, 3);
  console.log(
    "FIRST3_RAW",
    first3.map((s) => ({
      ticker: s.ticker,
      group: s.shariahGroup,
      sector: s.sector,
      tradable: s.isTradable,
      regulatory: s.regulatoryStatus,
    })),
  );

  const eligible = first3.filter((s) => {
    if (!s.isTradable) return false;
    if (s.regulatoryStatus === "restricted" || s.regulatoryStatus === "suspended") return false;
    const status = normalizeShariahGroup(s.shariahGroup);
    if (!status || !groups.includes(status)) return false;
    if (restrictedStockIds.has(s.id)) return false;
    if (restrictedSectors.has((s.sector || "").toLowerCase())) return false;
    return true;
  });

  const useStocks = (eligible.length > 0 ? eligible : first3).slice(0, 3);
  if (eligible.length === 0) {
    console.warn("WARNING: none of first 3 stocks pass mandate filters; sheet may fail BUY checks");
  }
  console.log("USE_STOCKS", useStocks.map((s) => ({ ticker: s.ticker, group: s.shariahGroup, sector: s.sector })));

  const stockIds = useStocks.map((s) => s.id);
  const prices = await db
    .select()
    .from(schema.stockPrices)
    .where(inArray(schema.stockPrices.stockId, stockIds))
    .orderBy(desc(schema.stockPrices.date))
    .limit(800);

  const byStockDate = new Map<string, typeof prices>();
  for (const p of prices) {
    if (!byStockDate.has(p.stockId)) byStockDate.set(p.stockId, []);
    byStockDate.get(p.stockId)!.push(p);
  }

  const dateSets = useStocks.map((s) => new Set((byStockDate.get(s.id) || []).map((p) => String(p.date).slice(0, 10))));
  let dates = [...(dateSets[0] || [])].filter((d) => dateSets.every((set) => set.has(d))).sort();
  if (dates.length < 15) {
    dates = [...new Set(prices.map((p) => String(p.date).slice(0, 10)))].sort();
  }
  dates = dates.slice(-40);
  if (dates.length === 0) throw new Error("No price dates found for first stocks");
  console.log("DATES", dates.length, dates[0], "→", dates[dates.length - 1]);

  function quote(stockId: string, date: string) {
    const rows = byStockDate.get(stockId) || [];
    const hit = rows.find((r) => String(r.date).slice(0, 10) === date);
    if (!hit) return null;
    const close = Number(hit.closePrice ?? hit.price);
    const hasLow = hit.lowPrice != null && Number(hit.lowPrice) > 0;
    const hasHigh = hit.highPrice != null && Number(hit.highPrice) > 0;
    const low = hasLow ? Number(hit.lowPrice) : close;
    const high = hasHigh ? Number(hit.highPrice) : close;
    if (!Number.isFinite(close) || close <= 0) return null;
    const bandLow = hasLow && hasHigh ? Math.min(low, high, close) : null;
    const bandHigh = hasLow && hasHigh ? Math.max(low, high, close) : null;
    // Prefer a fill inside the day band when present; otherwise use close.
    let fill = close;
    if (bandLow != null && bandHigh != null && bandHigh > bandLow) {
      const mid = (bandLow + bandHigh) / 2;
      fill = Math.min(bandHigh, Math.max(bandLow, mid));
    }
    return { close, low: bandLow, high: bandHigh, fill: Number(fill.toFixed(4)) };
  }

  const rows: { ticker: string; type: "BUY" | "SELL"; quantity: number; date: string; price: number }[] = [];
  const holdings = new Map<string, number>();
  let cash = 100000;

  // Use chronological dates from the window
  const start = Math.max(0, dates.length - 30);
  for (let i = 0; i < 30; i++) {
    const date = dates[Math.min(start + Math.floor(i / useStocks.length), dates.length - 1)];
    const stock = useStocks[i % useStocks.length];
    let q = quote(stock.id, date);
    let useDate = date;
    if (!q) {
      const any = (byStockDate.get(stock.id) || []).find((r) => Number(r.closePrice ?? r.price) > 0);
      if (!any) continue;
      useDate = String(any.date).slice(0, 10);
      q = quote(stock.id, useDate);
      if (!q) continue;
    }

    const held = holdings.get(stock.ticker) || 0;
    const doSell = i >= 10 && i % 5 === 0 && held >= 3;

    if (doSell) {
      const qty = Math.max(1, Math.min(held, Math.floor(held / 2)));
      cash += qty * q.fill;
      holdings.set(stock.ticker, held - qty);
      rows.push({ ticker: stock.ticker, type: "SELL", quantity: qty, date: useDate, price: q.fill });
      continue;
    }

    // Keep a cash buffer; spend a small slice each buy
    const budget = Math.min(cash * 0.06, cash - 2000);
    if (budget < q.fill) {
      if (held >= 1) {
        const qty = 1;
        cash += qty * q.fill;
        holdings.set(stock.ticker, held - qty);
        rows.push({ ticker: stock.ticker, type: "SELL", quantity: qty, date: useDate, price: q.fill });
      }
      continue;
    }

    let qty = Math.max(1, Math.floor(budget / q.fill));
    qty = Math.min(qty, 40);
    const cost = qty * q.fill;
    if (cost > cash) continue;
    cash -= cost;
    holdings.set(stock.ticker, held + qty);
    rows.push({ ticker: stock.ticker, type: "BUY", quantity: qty, date: useDate, price: q.fill });
  }

  // Fill to 30 if needed
  let guard = 0;
  while (rows.length < 30 && guard++ < 50) {
    const stock = useStocks[rows.length % useStocks.length];
    const useDate = dates[Math.min(dates.length - 1, dates.length - 5 + (rows.length % 5))];
    const q = quote(stock.id, useDate);
    if (!q) break;
    const held = holdings.get(stock.ticker) || 0;
    if (cash > q.fill * 2) {
      const qty = 1;
      cash -= qty * q.fill;
      holdings.set(stock.ticker, held + qty);
      rows.push({ ticker: stock.ticker, type: "BUY", quantity: qty, date: useDate, price: q.fill });
    } else if (held > 0) {
      const qty = 1;
      cash += qty * q.fill;
      holdings.set(stock.ticker, held - qty);
      rows.push({ ticker: stock.ticker, type: "SELL", quantity: qty, date: useDate, price: q.fill });
    } else break;
  }

  const outRows = rows.slice(0, 30);
  outRows.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  // Re-simulate in sorted order — may overspend if dates reorder buys before sells
  // Rebuild safely in sorted order from scratch
  const finalRows: typeof outRows = [];
  let simCash = 100000;
  const simHold = new Map<string, number>();
  for (const r of outRows) {
    const stock = useStocks.find((s) => s.ticker === r.ticker)!;
    const q = quote(stock.id, r.date);
    if (!q) continue;
    const px = r.price > 0 ? r.price : q.fill;
    if (r.type === "BUY") {
      const cost = r.quantity * px;
      if (cost > simCash + 0.01) {
        const maxQty = Math.floor(simCash / px);
        if (maxQty < 1) continue;
        const qty = maxQty;
        simCash -= qty * px;
        simHold.set(r.ticker, (simHold.get(r.ticker) || 0) + qty);
        finalRows.push({ ...r, quantity: qty, price: px });
      } else {
        simCash -= cost;
        simHold.set(r.ticker, (simHold.get(r.ticker) || 0) + r.quantity);
        finalRows.push({ ...r, price: px });
      }
    } else {
      const held = simHold.get(r.ticker) || 0;
      const qty = Math.min(r.quantity, held);
      if (qty < 1) continue;
      simCash += qty * px;
      simHold.set(r.ticker, held - qty);
      finalRows.push({ ...r, quantity: qty, price: px });
    }
  }

  // Top up to 30 with tiny valid buys if needed
  guard = 0;
  while (finalRows.length < 30 && guard++ < 80) {
    const stock = useStocks[finalRows.length % useStocks.length];
    const useDate = dates[dates.length - 1];
    const q = quote(stock.id, useDate);
    if (!q) break;
    if (simCash >= q.fill) {
      finalRows.push({ ticker: stock.ticker, type: "BUY", quantity: 1, date: useDate, price: q.fill });
      simCash -= q.fill;
      simHold.set(stock.ticker, (simHold.get(stock.ticker) || 0) + 1);
    } else {
      const ticker = [...simHold.entries()].find(([, qnty]) => qnty > 0)?.[0];
      if (!ticker) break;
      const st = useStocks.find((s) => s.ticker === ticker)!;
      const qq = quote(st.id, useDate);
      if (!qq) break;
      finalRows.push({ ticker, type: "SELL", quantity: 1, date: useDate, price: qq.fill });
      simCash += qq.fill;
      simHold.set(ticker, (simHold.get(ticker) || 0) - 1);
    }
  }

  finalRows.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  // Final cash validation pass
  simCash = 100000;
  simHold.clear();
  for (const r of finalRows) {
    if (r.type === "BUY") {
      simCash -= r.quantity * r.price;
      simHold.set(r.ticker, (simHold.get(r.ticker) || 0) + r.quantity);
    } else {
      simCash += r.quantity * r.price;
      simHold.set(r.ticker, (simHold.get(r.ticker) || 0) - r.quantity);
    }
  }

  console.log("ROWS", finalRows.length);
  console.log("SIM_CASH_END", simCash.toFixed(2));
  console.log("SIM_HOLD", Object.fromEntries(simHold));
  console.log(
    "BUY/SELL",
    finalRows.filter((r) => r.type === "BUY").length,
    finalRows.filter((r) => r.type === "SELL").length,
  );
  if (simCash < -0.01) throw new Error("Simulation went negative cash");
  if ([...simHold.values()].some((v) => v < -0.01)) throw new Error("Simulation short shares");

  const ws = XLSX.utils.json_to_sheet(finalRows.slice(0, 30));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "transactions");
  const outPath = path.resolve(__dirname, "..", "test-transactions-30.xlsx");
  XLSX.writeFile(wb, outPath);
  console.log("WROTE", outPath);
  console.log("CLIENT", chosen.customerName, "|", chosen.status, "|", chosen.shariah);
  console.log("STOCKS", useStocks.map((s) => s.ticker).join(", "));
  console.log("INSTRUCTIONS: Deposit 100000 cash first, then bulk-upload this file.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
