import "dotenv/config";
import { db, schema } from "./connection.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";
import { executeStockTrade } from "../services/trade-cash.js";
import { adjustActiveBandHwm } from "../services/fee-engine.js";

const ADMIN_EMAIL = "admin@gmail.com";
const ADMIN_PASSWORD = "ahmed-083";

const QSE_SECTORS = [
  { name: "Banks & Financial Services", description: "Qatar banking sector, financial institutions, and investment services", keywords: "banks financial services QNB CBQ Doha Bank Masraf Al Rayan" },
  { name: "Industrials", description: "Industrial manufacturing, construction, and infrastructure", keywords: "industrials construction manufacturing infrastructure Qatar" },
  { name: "Consumer Goods & Services", description: "Retail, food, consumer products, and services", keywords: "consumer goods retail food services Qatar" },
  { name: "Insurance", description: "Insurance companies and related financial products", keywords: "insurance Qatar QGIG QLIC" },
  { name: "Real Estate", description: "Real estate development, property management, and REITs", keywords: "real estate property development Qatar Barwa Ezdan" },
  { name: "Telecom", description: "Telecommunications and digital services", keywords: "telecom Ooredoo Vodafone Qatar digital" },
  { name: "Transportation", description: "Logistics, shipping, aviation, and transportation services", keywords: "transportation logistics shipping aviation Qatar Airways" },
];

const IPS_LIMITS = [
  { key: "stock_soft_weight", value: "0.15", unit: "ratio", description: "Single stock soft limit 15%" },
  { key: "stock_hard_weight", value: "0.20", unit: "ratio", description: "Single stock hard limit 20%" },
  { key: "sector_soft_weight", value: "0.35", unit: "ratio", description: "Sector soft limit 35%" },
  { key: "sector_hard_weight", value: "0.40", unit: "ratio", description: "Sector hard limit 40%" },
  { key: "loss_15", value: "-0.15", unit: "ratio", description: "Stock loss review trigger" },
  { key: "loss_25", value: "-0.25", unit: "ratio", description: "Stock loss exit plan trigger" },
  { key: "loss_30", value: "-0.30", unit: "ratio", description: "Stock loss urgent approval" },
  { key: "underperform_3m", value: "-0.05", unit: "ratio", description: "3M underperformance vs benchmark" },
  { key: "excess_cash_ratio", value: "0.10", unit: "ratio", description: "Excess cash policy" },
  { key: "days_reduce_stock_20", value: "10", unit: "days", description: "Days to reduce stock >20% to 15%" },
  { key: "days_reduce_sector_40", value: "5", unit: "days", description: "Days to reduce sector >40% to 35%" },
  { key: "adtv_illiquid", value: "100000", unit: "qar", description: "Illiquidity ADTV threshold" },
];

const MODELS = [
  { code: "FS_MED", name: "Fully Shariah Medium", shariahPreference: "fully_shariah" as const, riskProfile: "medium" as const, constructionStyle: "core_satellite" as const, coreWeight: "0.65", satelliteWeight: "0.35" },
  { code: "FS_HIGH", name: "Fully Shariah High", shariahPreference: "fully_shariah" as const, riskProfile: "high" as const, constructionStyle: "full_active" as const, coreWeight: "0", satelliteWeight: "1" },
  { code: "SP_MED", name: "Shariah + Purifying Medium", shariahPreference: "shariah_purifying" as const, riskProfile: "medium" as const, constructionStyle: "core_satellite" as const, coreWeight: "0.65", satelliteWeight: "0.35" },
  { code: "SP_HIGH", name: "Shariah + Purifying High", shariahPreference: "shariah_purifying" as const, riskProfile: "high" as const, constructionStyle: "full_active" as const, coreWeight: "0", satelliteWeight: "1" },
  { code: "UN_MED", name: "Unrestricted Medium", shariahPreference: "unrestricted" as const, riskProfile: "medium" as const, constructionStyle: "core_satellite" as const, coreWeight: "0.65", satelliteWeight: "0.35" },
  { code: "UN_HIGH", name: "Unrestricted High", shariahPreference: "unrestricted" as const, riskProfile: "high" as const, constructionStyle: "full_active" as const, coreWeight: "0", satelliteWeight: "1" },
];

const DEMO_STOCKS = [
  { ticker: "QNBK", companyName: "Qatar National Bank", sector: "Banks & Financial Services", shariahGroup: "not_shariah", basePrice: 16.4, adtv: "42000000" },
  { ticker: "QIBK", companyName: "Qatar Islamic Bank", sector: "Banks & Financial Services", shariahGroup: "shariah", basePrice: 19.8, adtv: "18000000" },
  { ticker: "MARK", companyName: "Masraf Al Rayan", sector: "Banks & Financial Services", shariahGroup: "shariah", basePrice: 2.45, adtv: "12000000" },
  { ticker: "CBQK", companyName: "The Commercial Bank", sector: "Banks & Financial Services", shariahGroup: "not_shariah", basePrice: 4.85, adtv: "9000000" },
  { ticker: "DHBK", companyName: "Doha Bank", sector: "Banks & Financial Services", shariahGroup: "not_shariah", basePrice: 1.72, adtv: "3500000" },
  { ticker: "QIIK", companyName: "Qatar International Islamic Bank", sector: "Banks & Financial Services", shariahGroup: "shariah", basePrice: 10.6, adtv: "4500000" },
  { ticker: "IQCD", companyName: "Industries Qatar", sector: "Industrials", shariahGroup: "shariah", basePrice: 12.9, adtv: "15000000" },
  { ticker: "QEWS", companyName: "Qatar Electricity & Water", sector: "Industrials", shariahGroup: "shariah", basePrice: 16.1, adtv: "2800000" },
  { ticker: "QGTS", companyName: "Qatar Gas Transport (Nakilat)", sector: "Transportation", shariahGroup: "shariah", basePrice: 4.55, adtv: "7000000" },
  { ticker: "ORDS", companyName: "Ooredoo", sector: "Telecom", shariahGroup: "not_shariah", basePrice: 11.4, adtv: "8500000" },
  { ticker: "VFQS", companyName: "Vodafone Qatar", sector: "Telecom", shariahGroup: "shariah", basePrice: 2.18, adtv: "5200000" },
  { ticker: "BRES", companyName: "Barwa Real Estate", sector: "Real Estate", shariahGroup: "shariah", basePrice: 2.72, adtv: "6100000" },
  { ticker: "ERES", companyName: "Ezdan Holding Group", sector: "Real Estate", shariahGroup: "shariah", basePrice: 1.05, adtv: "2400000" },
  { ticker: "MERS", companyName: "Al Meera Consumer Goods", sector: "Consumer Goods & Services", shariahGroup: "shariah", basePrice: 14.7, adtv: "1600000" },
  { ticker: "QATI", companyName: "Qatar Insurance Company", sector: "Insurance", shariahGroup: "not_shariah", basePrice: 2.08, adtv: "1900000" },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function tradingDaysBack(count: number, from = new Date()): string[] {
  const days: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 5 && dow !== 6) days.push(isoDate(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

function demoPrice(base: number, dayIndex: number, ticker: string): number {
  const wobble = Math.sin(dayIndex / 8 + ticker.charCodeAt(0)) * 0.035;
  const drift = dayIndex * 0.00035;
  return Math.round(base * (1 + drift + wobble) * 10000) / 10000;
}

async function upsertUser(username: string, password: string, displayName: string, role: string) {
  const existing = await db.select().from(schema.admins).where(eq(schema.admins.username, username)).limit(1);
  if (existing.length === 0) {
    const hash = await bcrypt.hash(password, 10);
    await db.insert(schema.admins).values({ username, passwordHash: hash, displayName, role });
    console.log(`[seed] User created ${username} (${role})`);
    return;
  }
  // SEC-01: never rewrite password hashes on boot seed (preserves local password changes).
  // Opt-in reset: SEED_RESET_PASSWORDS=1
  if (process.env.SEED_RESET_PASSWORDS === "1") {
    const hash = await bcrypt.hash(password, 10);
    await db.update(schema.admins).set({
      passwordHash: hash,
      displayName: existing[0].displayName || displayName,
      role: existing[0].role || role,
      status: "active",
      updatedAt: new Date(),
    }).where(eq(schema.admins.id, existing[0].id));
    console.log(`[seed] User password reset ${username} (${role})`);
    return;
  }
  await db.update(schema.admins).set({
    displayName: existing[0].displayName || displayName,
    role: existing[0].role || role,
    status: "active",
    updatedAt: new Date(),
  }).where(eq(schema.admins.id, existing[0].id));
  console.log(`[seed] User ensured ${username} (password unchanged)`);
}

async function seedUsers() {
  await upsertUser(ADMIN_EMAIL, ADMIN_PASSWORD, "System Admin", "admin");
  await upsertUser("admin", ADMIN_PASSWORD, "System Admin", "admin");
  await upsertUser(
    process.env.SUPER_ADMIN_USERNAME || "super_admin@gmail.com",
    process.env.SUPER_ADMIN_PASSWORD || ADMIN_PASSWORD,
    "Super Admin",
    "admin",
  );
  await upsertUser("pm", "pm", "Portfolio Manager", "pm");
  await upsertUser("approver", "approver", "Approver", "approver");
  await upsertUser("compliance", "compliance", "Compliance Officer", "compliance");
}

async function seedReference() {
  const existingSectors = await db.select().from(schema.sectors);
  if (existingSectors.length === 0) {
    await db.insert(schema.sectors).values(QSE_SECTORS);
    console.log(`[seed] ${QSE_SECTORS.length} QSE sectors created`);
  } else {
    console.log(`[seed] Sectors already seeded (${existingSectors.length} found)`);
  }

  for (const name of ["DSM", "QERI"]) {
    const found = await db.select().from(schema.indices).where(eq(schema.indices.name, name)).limit(1);
    if (found.length === 0) {
      await db.insert(schema.indices).values({
        name,
        description: name === "DSM"
          ? "QE General Index / DSM (unrestricted benchmark)"
          : "QE Al Rayan Islamic Index (Shariah benchmark)",
      });
      console.log(`[seed] Index ${name} created`);
    }
  }

  const existingLimits = await db.select().from(schema.ipsLimitConfig);
  if (existingLimits.length === 0) {
    await db.insert(schema.ipsLimitConfig).values(IPS_LIMITS);
    console.log(`[seed] ${IPS_LIMITS.length} IPS limits seeded`);
  }

  const existingModels = await db.select().from(schema.modelPortfolios);
  if (existingModels.length === 0) {
    const dsm = await db.select().from(schema.indices).where(eq(schema.indices.name, "DSM")).limit(1);
    const qeri = await db.select().from(schema.indices).where(eq(schema.indices.name, "QERI")).limit(1);
    await db.insert(schema.modelPortfolios).values(
      MODELS.map((m) => ({
        ...m,
        benchmarkIndexId: m.shariahPreference === "unrestricted" ? dsm[0]?.id : qeri[0]?.id,
      })),
    );
    console.log(`[seed] ${MODELS.length} model portfolios seeded`);
  }
}

async function seedDemoMarket() {
  const existingStocks = await db.select().from(schema.stocks);
  if (existingStocks.length > 0) {
    console.log(`[seed] Stocks already present (${existingStocks.length}) — skipping demo market`);
    return;
  }

  await db.insert(schema.stocks).values(
    DEMO_STOCKS.map((s) => ({
      ticker: s.ticker,
      companyName: s.companyName,
      sector: s.sector,
      instrumentType: "equity" as const,
      shariahGroup: s.shariahGroup,
      avgDailyTradedValue: s.adtv,
      isIlliquid: false,
      regulatoryStatus: "clear",
      isTradable: true,
      isDsmMember: true,
      isQeriMember: s.shariahGroup === "shariah",
    })),
  );
  console.log(`[seed] ${DEMO_STOCKS.length} demo QSE stocks created`);

  const stocks = await db.select().from(schema.stocks);
  const byTicker = new Map(stocks.map((s) => [s.ticker.toUpperCase(), s]));
  const days = tradingDaysBack(80);

  const priceRows: {
    stockId: string;
    date: string;
    price: string;
    openPrice: string;
    highPrice: string;
    lowPrice: string;
    closePrice: string;
  }[] = [];

  for (const spec of DEMO_STOCKS) {
    const stock = byTicker.get(spec.ticker);
    if (!stock) continue;
    days.forEach((date, i) => {
      const close = demoPrice(spec.basePrice, i, spec.ticker);
      const open = Math.round(close * 0.997 * 10000) / 10000;
      const high = Math.round(close * 1.012 * 10000) / 10000;
      const low = Math.round(close * 0.988 * 10000) / 10000;
      priceRows.push({
        stockId: stock.id,
        date,
        price: String(close),
        openPrice: String(open),
        highPrice: String(high),
        lowPrice: String(low),
        closePrice: String(close),
      });
    });
  }

  const BATCH = 400;
  for (let i = 0; i < priceRows.length; i += BATCH) {
    await db.insert(schema.stockPrices).values(priceRows.slice(i, i + BATCH)).onConflictDoNothing();
  }
  console.log(`[seed] ${priceRows.length} demo prices created`);

  const dsm = (await db.select().from(schema.indices).where(eq(schema.indices.name, "DSM")).limit(1))[0];
  const qeri = (await db.select().from(schema.indices).where(eq(schema.indices.name, "QERI")).limit(1))[0];
  if (dsm && qeri) {
    const indexPoints = days.flatMap((date, i) => [
      { indexId: dsm.id, date, value: String(Math.round((10480 + i * 1.8 + Math.sin(i / 6) * 35) * 100) / 100) },
      { indexId: qeri.id, date, value: String(Math.round((4780 + i * 1.1 + Math.sin(i / 7) * 18) * 100) / 100) },
    ]);
    await db.insert(schema.indexDataPoints).values(indexPoints).onConflictDoNothing();
    console.log(`[seed] ${indexPoints.length} index points created`);

    const asOf = days[days.length - 1];
    const dsmWeights: Record<string, string> = {
      QNBK: "0.18", QIBK: "0.12", MARK: "0.08", CBQK: "0.07", IQCD: "0.11",
      ORDS: "0.08", QGTS: "0.07", QEWS: "0.05", VFQS: "0.05", BRES: "0.05",
      QIIK: "0.04", DHBK: "0.03", MERS: "0.03", QATI: "0.02", ERES: "0.02",
    };
    const qeriWeights: Record<string, string> = {
      QIBK: "0.18", MARK: "0.14", IQCD: "0.13", QGTS: "0.10", QEWS: "0.09",
      VFQS: "0.08", BRES: "0.08", QIIK: "0.07", MERS: "0.06", ERES: "0.07",
    };

    const dsmConstituents = Object.entries(dsmWeights)
      .map(([ticker, weight]) => {
        const stock = byTicker.get(ticker);
        return stock ? { indexId: dsm.id, stockId: stock.id, weight, effectiveDate: asOf } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const qeriConstituents = Object.entries(qeriWeights)
      .map(([ticker, weight]) => {
        const stock = byTicker.get(ticker);
        return stock ? { indexId: qeri.id, stockId: stock.id, weight, effectiveDate: asOf } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    if (dsmConstituents.length) await db.insert(schema.indexConstituents).values(dsmConstituents).onConflictDoNothing();
    if (qeriConstituents.length) await db.insert(schema.indexConstituents).values(qeriConstituents).onConflictDoNothing();
    console.log("[seed] Index constituents created");

    const fsMed = (await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, "FS_MED")).limit(1))[0];
    const unHigh = (await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, "UN_HIGH")).limit(1))[0];
    const modelRows: { modelPortfolioId: string; stockId: string; targetWeight: string; sleeve: string }[] = [];
    if (fsMed) {
      for (const [ticker, weight] of Object.entries({ QIBK: "0.22", MARK: "0.18", IQCD: "0.16", QGTS: "0.14", QEWS: "0.12", VFQS: "0.10", BRES: "0.08" })) {
        const stock = byTicker.get(ticker);
        if (stock) modelRows.push({ modelPortfolioId: fsMed.id, stockId: stock.id, targetWeight: weight, sleeve: "core" });
      }
    }
    if (unHigh) {
      for (const [ticker, weight] of Object.entries({ QNBK: "0.20", IQCD: "0.16", ORDS: "0.14", QIBK: "0.14", CBQK: "0.12", QGTS: "0.12", MARK: "0.12" })) {
        const stock = byTicker.get(ticker);
        if (stock) modelRows.push({ modelPortfolioId: unHigh.id, stockId: stock.id, targetWeight: weight, sleeve: "active" });
      }
    }
    if (modelRows.length) {
      await db.insert(schema.modelHoldings).values(modelRows).onConflictDoNothing();
      console.log(`[seed] ${modelRows.length} model holdings created`);
    }
  }
}

async function depositCash(portfolioId: string, customerId: string, amount: number, tradeDate: string, notes: string) {
  await db.insert(schema.cashTransactions).values({
    portfolioId,
    type: "deposit",
    amount: String(amount),
    tradeDate,
    reference: "SEED-DEPOSIT",
    notes,
  });
  const [portfolio] = await db.select().from(schema.portfolios).where(eq(schema.portfolios.id, portfolioId)).limit(1);
  const next = Number(portfolio?.cashBalance ?? 0) + amount;
  await db.update(schema.portfolios).set({ cashBalance: String(next), updatedAt: new Date() }).where(eq(schema.portfolios.id, portfolioId));
  await adjustActiveBandHwm(customerId, amount, tradeDate);
}

async function seedDemoClients() {
  const existingCustomers = await db.select().from(schema.customers);
  if (existingCustomers.length > 0) {
    console.log(`[seed] Customers already present (${existingCustomers.length}) — skipping demo clients`);
    return;
  }

  const stocks = await db.select().from(schema.stocks);
  if (stocks.length === 0) {
    console.log("[seed] No stocks available — skipping demo clients");
    return;
  }

  const byTicker = new Map(stocks.map((s) => [s.ticker.toUpperCase(), s]));
  const dsm = (await db.select().from(schema.indices).where(eq(schema.indices.name, "DSM")).limit(1))[0];
  const qeri = (await db.select().from(schema.indices).where(eq(schema.indices.name, "QERI")).limit(1))[0];
  const fsMed = (await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, "FS_MED")).limit(1))[0];
  const unHigh = (await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, "UN_HIGH")).limit(1))[0];
  const fsHigh = (await db.select().from(schema.modelPortfolios).where(eq(schema.modelPortfolios.code, "FS_HIGH")).limit(1))[0];
  const [pm] = await db.select().from(schema.admins).where(eq(schema.admins.username, "pm")).limit(1);
  const [approver] = await db.select().from(schema.admins).where(eq(schema.admins.username, "approver")).limit(1);

  const days = tradingDaysBack(80);
  const inception = days[Math.max(0, days.length - 60)];
  const depositDate = days[Math.max(0, days.length - 55)];
  const buyDateA = days[Math.max(0, days.length - 40)];
  const buyDateB = days[Math.max(0, days.length - 20)];

  const [clientA] = await db.insert(schema.customers).values({
    name: "Ahmed Al-Thani",
    email: "ahmed.althani@demo.qsc",
    joinDate: inception,
    accountNumber: "QA-10001",
    portfolioManagerId: pm?.id ?? null,
    notes: "Demo Shariah discretionary account",
    clientType: "individual",
    title: "Mr",
    gender: "male",
    birthdate: "1984-03-12",
    nationality: "Qatari",
    mobileNumber: "+97455501001",
    city: "Doha",
    country: "Qatar",
    idNumber: "28412345678",
    idValidity: "2030-03-12",
  }).returning();

  const [clientB] = await db.insert(schema.customers).values({
    name: "Gulf Holdings W.L.L.",
    email: "treasury@gulfholdings.demo",
    joinDate: inception,
    accountNumber: "QA-10002",
    portfolioManagerId: pm?.id ?? null,
    notes: "Demo unrestricted corporate account",
    clientType: "company",
    nationality: "Qatari",
    mobileNumber: "+97444421002",
    city: "Doha",
    country: "Qatar",
    idNumber: "CR-44521",
    idValidity: "2028-12-31",
  }).returning();

  const [clientC] = await db.insert(schema.customers).values({
    name: "Sara Al-Kuwari",
    email: "sara.alkuwari@demo.qsc",
    joinDate: days[days.length - 10],
    accountNumber: "QA-10003",
    portfolioManagerId: pm?.id ?? null,
    notes: "Demo pending-mandate account (cash only)",
    clientType: "individual",
    title: "Ms",
    gender: "female",
    birthdate: "1992-07-21",
    nationality: "Qatari",
    mobileNumber: "+97455501003",
    city: "Lusail",
    country: "Qatar",
    idNumber: "29276543210",
    idValidity: "2031-07-21",
  }).returning();

  const [portA] = await db.insert(schema.portfolios).values({
    customerId: clientA.id,
    name: `${clientA.name} Portfolio`,
    benchmarkIndexId: qeri?.id,
    modelPortfolioId: fsMed?.id,
    cashBalance: "0",
    inceptionDate: inception,
    status: "active",
  }).returning();
  const [portB] = await db.insert(schema.portfolios).values({
    customerId: clientB.id,
    name: `${clientB.name} Portfolio`,
    benchmarkIndexId: dsm?.id,
    modelPortfolioId: unHigh?.id,
    cashBalance: "0",
    inceptionDate: inception,
    status: "active",
  }).returning();
  const [portC] = await db.insert(schema.portfolios).values({
    customerId: clientC.id,
    name: `${clientC.name} Portfolio`,
    benchmarkIndexId: qeri?.id,
    modelPortfolioId: fsHigh?.id,
    cashBalance: "0",
    inceptionDate: days[days.length - 10],
    status: "active",
  }).returning();

  const approvedAt = new Date(`${buyDateA}T08:00:00.000Z`);
  const [mandateA] = await db.insert(schema.mandates).values({
    customerId: clientA.id,
    shariahPreference: "fully_shariah",
    riskProfile: "medium",
    benchmarkIndexId: qeri?.id,
    modelPortfolioId: fsMed?.id,
    approvalStatus: "approved",
    approvedBy: approver?.id ?? null,
    approvedAt,
    contractStart: inception,
    contractEnd: "2028-12-31",
    initialValue: "2500000",
    notes: "Demo fully Shariah medium-risk mandate",
  }).returning();
  const [mandateB] = await db.insert(schema.mandates).values({
    customerId: clientB.id,
    shariahPreference: "unrestricted",
    riskProfile: "high",
    benchmarkIndexId: dsm?.id,
    modelPortfolioId: unHigh?.id,
    approvalStatus: "approved",
    approvedBy: approver?.id ?? null,
    approvedAt,
    contractStart: inception,
    contractEnd: "2027-12-31",
    initialValue: "5000000",
    notes: "Demo unrestricted high-risk mandate",
  }).returning();
  await db.insert(schema.mandates).values({
    customerId: clientC.id,
    shariahPreference: "fully_shariah",
    riskProfile: "high",
    benchmarkIndexId: qeri?.id,
    modelPortfolioId: fsHigh?.id,
    approvalStatus: "pending",
    contractStart: days[days.length - 10],
    initialValue: "800000",
    notes: "Awaiting investment committee approval",
  });

  await db.insert(schema.mandateFeeBands).values([
    {
      mandateId: mandateA.id,
      effectiveFrom: inception,
      rebateCommissionPct: "0.15",
      annualManagementFeePct: "0.0125",
      performanceFeePct: "0.10",
      performanceFrequency: "annual",
      performanceHurdlePct: "0.06",
      highWaterMark: "0",
    },
    {
      mandateId: mandateB.id,
      effectiveFrom: inception,
      rebateCommissionPct: "0.10",
      annualManagementFeePct: "0.0100",
      performanceFeePct: "0.15",
      performanceFrequency: "annual",
      performanceHurdlePct: "0.08",
      highWaterMark: "0",
    },
  ]);

  await depositCash(portA.id, clientA.id, 2_500_000, depositDate, "Initial funding — Shariah account");
  await depositCash(portB.id, clientB.id, 5_000_000, depositDate, "Initial funding — corporate account");
  await depositCash(portC.id, clientC.id, 800_000, days[days.length - 8], "Subscription received — pending mandate");

  const trades: { portfolioId: string; ticker: string; qty: number; date: string }[] = [
    { portfolioId: portA.id, ticker: "QIBK", qty: 18000, date: buyDateA },
    { portfolioId: portA.id, ticker: "MARK", qty: 120000, date: buyDateA },
    { portfolioId: portA.id, ticker: "IQCD", qty: 22000, date: buyDateA },
    { portfolioId: portA.id, ticker: "QGTS", qty: 70000, date: buyDateB },
    { portfolioId: portA.id, ticker: "QEWS", qty: 9000, date: buyDateB },
    { portfolioId: portB.id, ticker: "QNBK", qty: 55000, date: buyDateA },
    { portfolioId: portB.id, ticker: "ORDS", qty: 40000, date: buyDateA },
    { portfolioId: portB.id, ticker: "CBQK", qty: 90000, date: buyDateA },
    { portfolioId: portB.id, ticker: "IQCD", qty: 30000, date: buyDateB },
    { portfolioId: portB.id, ticker: "MARK", qty: 150000, date: buyDateB },
  ];

  let tradeCount = 0;
  for (const t of trades) {
    const stock = byTicker.get(t.ticker);
    if (!stock) continue;
    await executeStockTrade({
      portfolioId: t.portfolioId,
      stockId: stock.id,
      type: "BUY",
      quantity: t.qty,
      timestamp: new Date(`${t.date}T10:00:00.000Z`),
      notes: "Demo seed trade",
      forceClosingPrice: true,
      skipPriceRange: true,
    });
    tradeCount += 1;
  }

  console.log(`[seed] Demo clients created: 3 customers, ${tradeCount} trades`);
}

export async function seed() {
  await seedUsers();
  await seedReference();
  await seedDemoMarket();
  await seedDemoClients();
}

const invokedDirectly = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
if (invokedDirectly) {
  seed()
    .then(() => {
      console.log("[seed] Complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[seed] FAILED", err);
      process.exit(1);
    });
}
