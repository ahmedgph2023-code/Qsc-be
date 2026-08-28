import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "../db/connection.js";
import { param } from "../utils/params.js";
import { authMiddleware, requireRole, roleOrViewer, type AuthRequest, type UserRole } from "../middleware/auth.js";
import { writeAudit, writeAuditTx } from "../services/audit.js";

const router = Router();
router.use(authMiddleware);
router.use(requireRole("admin"));

const ROLES: UserRole[] = ["admin", "pm", "approver", "compliance", "viewer"];

function publicUser(row: typeof schema.admins.$inferSelect) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName || row.username,
    role: roleOrViewer(row.role),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get("/", async (_req, res) => {
  try {
    const rows = await db.select().from(schema.admins).orderBy(asc(schema.admins.username));
    res.json(rows.map(publicUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req: AuthRequest, res) => {
  try {
    const { username, password, displayName, role, status } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: "password must be at least 6 characters" });
      return;
    }
    const nextRole = roleOrViewer(role);
    if (!ROLES.includes(nextRole)) {
      res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
      return;
    }
    const hash = await bcrypt.hash(String(password), 10);
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.admins).values({
        username: String(username).trim(),
        passwordHash: hash,
        displayName: displayName ? String(displayName).trim() : String(username).trim(),
        role: nextRole,
        status: status === "disabled" ? "disabled" : "active",
      }).returning();
      await writeAuditTx(tx, {
        userId: req.userId,
        action: "create",
        objectType: "user",
        objectId: row.id,
        newValue: { username: row.username, role: row.role, status: row.status },
      });
      return row;
    });
    res.status(201).json(publicUser(created));
  } catch (err: any) {
    if (String(err.message || "").includes("unique") || err.code === "23505") {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const id = param(req.params.id);
    const [existing] = await db.select().from(schema.admins).where(eq(schema.admins.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const { displayName, role, status, password } = req.body || {};
    const patch: Partial<typeof schema.admins.$inferInsert> = { updatedAt: new Date() };
    if (displayName != null) patch.displayName = String(displayName).trim();
    if (role != null) {
      const nextRole = roleOrViewer(role);
      if (!ROLES.includes(nextRole)) {
        res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
        return;
      }
      patch.role = nextRole;
    }
    if (status != null) {
      if (status !== "active" && status !== "disabled") {
        res.status(400).json({ error: "status must be active or disabled" });
        return;
      }
      if (id === req.userId && status === "disabled") {
        res.status(400).json({ error: "Cannot disable your own account" });
        return;
      }
      patch.status = status;
    }
    if (password) {
      if (String(password).length < 6) {
        res.status(400).json({ error: "password must be at least 6 characters" });
        return;
      }
      patch.passwordHash = await bcrypt.hash(String(password), 10);
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.admins).set(patch).where(eq(schema.admins.id, id)).returning();
      await writeAuditTx(tx, {
        userId: req.userId,
        action: "update",
        objectType: "user",
        objectId: id,
        oldValue: { username: existing.username, role: existing.role, status: existing.status },
        newValue: { username: row.username, role: row.role, status: row.status, passwordChanged: !!password },
      });
      return row;
    });
    res.json(publicUser(updated));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const id = param(req.params.id);
    if (id === req.userId) {
      res.status(400).json({ error: "Cannot delete your own account" });
      return;
    }
    const [existing] = await db.select().from(schema.admins).where(eq(schema.admins.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.admins).where(eq(schema.admins.id, id));
      await writeAuditTx(tx, {
        userId: req.userId,
        action: "delete",
        objectType: "user",
        objectId: id,
        oldValue: { username: existing.username, role: existing.role },
      });
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
