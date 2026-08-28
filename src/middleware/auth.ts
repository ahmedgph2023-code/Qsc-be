import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isSuperAdminUsername } from "../lib/super-admin.js";
import { resolveJwtSecret } from "../lib/jwt-secret.js";

const JWT_SECRET = resolveJwtSecret();

export type UserRole = "admin" | "pm" | "compliance" | "approver" | "viewer";

const VALID_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "pm",
  "compliance",
  "approver",
  "viewer",
]);

export function parseUserRole(raw?: string | null): UserRole | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  return VALID_ROLES.has(v) ? (v as UserRole) : null;
}

/** Least privilege when DB role is missing/invalid (never default to admin). */
export function roleOrViewer(raw?: string | null): UserRole {
  return parseUserRole(raw) ?? "viewer";
}

export interface AuthRequest extends Request {
  adminId?: string;
  userId?: string;
  userRole?: UserRole;
  username?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      adminId: string;
      role?: string;
      username?: string;
    };
    const role = parseUserRole(payload.role);
    if (!role) {
      res.status(401).json({ error: "Invalid token", message: "Token missing valid role" });
      return;
    }
    req.adminId = payload.adminId;
    req.userId = payload.adminId;
    req.userRole = role;
    req.username = payload.username;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.userRole || "viewer";
    if (role === "admin" || roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({ error: "FORBIDDEN", message: `Requires role: ${roles.join(" | ")}` });
  };
}

/** Broker-sheet import only. Generic `admin` role is not enough (`requireRole` would let every admin through). */
export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (isSuperAdminUsername(req.username)) {
    next();
    return;
  }
  res.status(403).json({ error: "FORBIDDEN", message: "Requires super_admin access" });
}

export { JWT_SECRET };
