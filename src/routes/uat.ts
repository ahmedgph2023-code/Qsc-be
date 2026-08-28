import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getUatBoard } from "../services/uat-gate.js";

const router = Router();
router.use(authMiddleware);

router.get("/status", (_req, res) => {
  res.json(getUatBoard());
});

export default router;
