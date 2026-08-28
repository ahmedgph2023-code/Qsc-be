import { Router } from "express";
import { authMiddleware, requireSuperAdmin, type AuthRequest } from "../middleware/auth.js";
import { DEFAULT_PORTFOLIO_FORMULAS, FORMULA_COLUMNS, listPortfolioFormulas, updatePortfolioFormula } from "../services/portfolio-formulas.js";

function errStatus(e: unknown) {
  return typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
}

const router = Router();
router.use(authMiddleware, requireSuperAdmin);

router.get("/", async (_req, res) => {
  try {
    const rows = await listPortfolioFormulas();
    const defaults = new Map(DEFAULT_PORTFOLIO_FORMULAS.map((d) => [d.key, d.expression]));
    res.json({
      columns: FORMULA_COLUMNS,
      formulas: rows.map((row) => ({
        ...row,
        defaultExpression: defaults.get(row.key) ?? row.expression,
      })),
    });
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Load failed" });
  }
});

router.put("/:key", async (req: AuthRequest, res) => {
  try {
    const row = await updatePortfolioFormula({
      key: String(req.params.key),
      expression: String(req.body?.expression ?? ""),
      userId: req.adminId,
    });
    res.json(row);
  } catch (e) {
    res.status(errStatus(e)).json({ error: e instanceof Error ? e.message : "Update failed" });
  }
});

export default router;
