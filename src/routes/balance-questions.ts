import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getBalanceQuestionBoard } from "../services/balance-questions.js";

const router = Router();
router.use(authMiddleware);

router.get("/", (_req, res) => {
  res.json(getBalanceQuestionBoard());
});

export default router;
