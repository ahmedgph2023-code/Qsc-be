import { Router } from "express";
import { db, schema } from "../db/connection.js";
import { eq } from "drizzle-orm";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { getPortfolioMetrics } from "../services/calculations.js";
import { param, queryAsOf } from "../utils/params.js";

const router = Router();
router.use(authMiddleware);

async function attachSummary(customer: any, asOf?: string) {
  const portfolio = await db.select().from(schema.portfolios).where(eq(schema.portfolios.customerId, customer.id)).limit(1);
  if (portfolio.length === 0) return { ...customer, totalInvested: 0, currentValue: 0, returnPct: 0, portfolioId: "" };
  const metrics = await getPortfolioMetrics(portfolio[0].id, asOf);
  return { ...customer, portfolioId: portfolio[0].id, asOf: asOf || null, ...metrics };
}

router.get("/", async (_req, res) => {
  try { const all = await db.select().from(schema.customers).orderBy(schema.customers.name); res.json(await Promise.all(all.map((c) => attachSummary(c)))); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const c = await db.select().from(schema.customers).where(eq(schema.customers.id, req.params.id)).limit(1);
    if (c.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    const identityOnly = req.query.identity === "1" || req.query.identity === "true";
    if (identityOnly) {
      const portfolio = await db.select({ id: schema.portfolios.id })
        .from(schema.portfolios).where(eq(schema.portfolios.customerId, c[0].id)).limit(1);
      res.json({
        ...c[0],
        portfolioId: portfolio[0]?.id ?? "",
        totalInvested: 0,
        currentValue: 0,
        returnPct: 0,
        asOf: null,
      });
      return;
    }
    res.json(await attachSummary(c[0], queryAsOf(req.query.asOf)));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

const VALID_CLIENT_TYPES = ["individual", "company"];
const VALID_GENDERS = ["male", "female"];

router.post("/", requireRole("admin", "pm"), async (req, res) => {
  try {
    const {
      name, email, joinDate,
      clientType, title, gender, birthdate, nationality,
      mobileNumber, city, country, idNumber, idValidity,
      accountNumber, notes,
    } = req.body;

    if (clientType && !VALID_CLIENT_TYPES.includes(clientType)) {
      res.status(400).json({ error: "clientType must be individual or company" });
      return;
    }
    if (gender && !VALID_GENDERS.includes(gender)) {
      res.status(400).json({ error: "gender must be male or female" });
      return;
    }

    const [created] = await db.insert(schema.customers).values({
      name,
      email,
      joinDate: joinDate || new Date().toISOString().split("T")[0],
      clientType: clientType || "individual",
      title: title || null,
      gender: gender || null,
      birthdate: birthdate || null,
      nationality: nationality || null,
      mobileNumber: mobileNumber || null,
      city: city || null,
      country: country || null,
      idNumber: idNumber || null,
      idValidity: idValidity || null,
      accountNumber: accountNumber || null,
      notes: notes || null,
    }).returning();
    const [p] = await db.insert(schema.portfolios).values({ customerId: created.id, name: `${created.name} Portfolio` }).returning();
    res.status(201).json({ ...created, portfolioId: p.id });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

function emptyToNull(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

router.put("/:id", requireRole("admin", "pm"), async (req, res) => {
  try {
    const {
      name, email, joinDate,
      clientType, title, gender, birthdate, nationality,
      mobileNumber, city, country, idNumber, idValidity,
      accountNumber, notes,
    } = req.body;

    if (clientType && !VALID_CLIENT_TYPES.includes(clientType)) {
      res.status(400).json({ error: "clientType must be individual or company" });
      return;
    }
    if (gender && !VALID_GENDERS.includes(gender)) {
      res.status(400).json({ error: "gender must be male or female" });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;
    if (joinDate !== undefined) patch.joinDate = joinDate;
    if (clientType !== undefined) patch.clientType = clientType;
    if (title !== undefined) patch.title = emptyToNull(title);
    if (gender !== undefined) patch.gender = emptyToNull(gender);
    if (birthdate !== undefined) patch.birthdate = emptyToNull(birthdate);
    if (nationality !== undefined) patch.nationality = emptyToNull(nationality);
    if (mobileNumber !== undefined) patch.mobileNumber = emptyToNull(mobileNumber);
    if (city !== undefined) patch.city = emptyToNull(city);
    if (country !== undefined) patch.country = emptyToNull(country);
    if (idNumber !== undefined) patch.idNumber = emptyToNull(idNumber);
    if (idValidity !== undefined) patch.idValidity = emptyToNull(idValidity);
    if (accountNumber !== undefined) patch.accountNumber = emptyToNull(accountNumber);
    if (notes !== undefined) patch.notes = emptyToNull(notes);

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const [u] = await db.update(schema.customers).set(patch).where(eq(schema.customers.id, param(req.params.id))).returning();
    if (!u) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await attachSummary(u));
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try { await db.delete(schema.customers).where(eq(schema.customers.id, param(req.params.id))); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
