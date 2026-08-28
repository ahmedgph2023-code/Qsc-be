import { Router } from "express";
import { db, schema } from "../db/connection.js";
import type { UiPreferences } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { writeAudit } from "../services/audit.js";
import { authMiddleware, roleOrViewer, type AuthRequest } from "../middleware/auth.js";
import { resolveJwtSecret } from "../lib/jwt-secret.js";

const router = Router();
const JWT_SECRET = resolveJwtSecret();

const VALID_THEMES = ["dark", "light", "system"];
const VALID_DENSITIES = ["compact", "default", "comfortable"];
const VALID_HEADER_PIN = ["sticky", "flow"];
const VALID_SIDEBAR_MODE = ["auto", "expanded", "collapsed"];
const VALID_PALETTES = ["blue", "violet", "teal", "orange", "rose", "indigo", "pink", "green", "gold", "spectrum"];
const VALID_ACCENTS = ["blue", "violet", "teal", "green", "orange", "rose", "gray", "indigo", "pink", "gold", "spectrum"];
const HEX = /^#([0-9a-f]{6})$/i;

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) { res.status(400).json({ error: "Username and password required" }); return; }
    const admins = await db.select().from(schema.admins).where(eq(schema.admins.username, username)).limit(1);
    if (admins.length === 0) { res.status(401).json({ error: "Invalid credentials" }); return; }
    const user = admins[0];
    if (user.status === "disabled") { res.status(401).json({ error: "Account disabled" }); return; }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) { res.status(401).json({ error: "Invalid credentials" }); return; }
    const role = roleOrViewer(user.role);
    const token = jwt.sign(
      { adminId: user.id, role, username: user.username },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    await writeAudit({
      userId: user.id, action: "login", objectType: "user", objectId: user.id,
      newValue: { username: user.username, role },
      throwOnFailure: false,
    });
    res.json({
      token,
      username: user.username,
      displayName: user.displayName || user.username,
      role,
      userId: user.id,
    });
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const payload = jwt.verify(authHeader.split(" ")[1], JWT_SECRET) as { adminId: string };
    const admins = await db.select().from(schema.admins).where(eq(schema.admins.id, payload.adminId)).limit(1);
    if (admins.length === 0) { res.status(401).json({ error: "Unauthorized" }); return; }
    const user = admins[0];
    res.json({
      username: user.username,
      displayName: user.displayName || user.username,
      role: roleOrViewer(user.role),
      userId: user.id,
      uiPreferences: user.uiPreferences || {},
    });
  } catch { res.status(401).json({ error: "Invalid token" }); }
});

router.get("/me/preferences", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const admins = await db.select().from(schema.admins).where(eq(schema.admins.id, req.adminId!)).limit(1);
    if (admins.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    res.json(admins[0].uiPreferences || {});
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

router.patch("/me/preferences", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    const patch: UiPreferences = {};
    if (body.theme !== undefined) {
      if (!VALID_THEMES.includes(body.theme)) { res.status(400).json({ error: "Invalid theme" }); return; }
      patch.theme = body.theme;
    }
    if (body.density !== undefined) {
      if (!VALID_DENSITIES.includes(body.density)) { res.status(400).json({ error: "Invalid density" }); return; }
      patch.density = body.density;
    }
    if (body.headerPin !== undefined) {
      if (!VALID_HEADER_PIN.includes(body.headerPin)) { res.status(400).json({ error: "Invalid headerPin" }); return; }
      patch.headerPin = body.headerPin;
    }
    if (body.sidebarMode !== undefined) {
      if (!VALID_SIDEBAR_MODE.includes(body.sidebarMode)) { res.status(400).json({ error: "Invalid sidebarMode" }); return; }
      patch.sidebarMode = body.sidebarMode;
    }
    if (body.palette !== undefined) {
      if (!VALID_PALETTES.includes(body.palette)) { res.status(400).json({ error: "Invalid palette" }); return; }
      patch.palette = body.palette;
    }
    if (body.accent !== undefined) {
      if (!(VALID_ACCENTS.includes(body.accent) || HEX.test(String(body.accent)))) {
        res.status(400).json({ error: "Invalid accent" }); return;
      }
      patch.accent = body.accent;
    }
    if (body.showClock !== undefined) {
      if (typeof body.showClock !== "boolean") { res.status(400).json({ error: "Invalid showClock" }); return; }
      patch.showClock = body.showClock;
    }

    const admins = await db.select().from(schema.admins).where(eq(schema.admins.id, req.adminId!)).limit(1);
    if (admins.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    const merged: UiPreferences = { ...(admins[0].uiPreferences || {}), ...patch };

    await db.update(schema.admins).set({ uiPreferences: merged, updatedAt: new Date() }).where(eq(schema.admins.id, req.adminId!));
    res.json(merged);
  } catch (err: any) { res.status(500).json({ error: err.cause?.message || err.message }); }
});

export default router;
