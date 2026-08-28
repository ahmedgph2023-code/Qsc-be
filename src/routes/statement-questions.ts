import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getStatementQuestionBoard } from "../services/statement-questions.js";

const router = Router();
router.use(authMiddleware);

router.get("/", (_req, res) => {
  res.json(getStatementQuestionBoard());
});

export default router;
