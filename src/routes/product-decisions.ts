import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getProductDecisionBoard } from "../services/product-decisions.js";

const router = Router();
router.use(authMiddleware);

router.get("/", (_req, res) => {
  res.json(getProductDecisionBoard());
});

export default router;
