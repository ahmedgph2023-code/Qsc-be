import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getBroadcastStatus } from "../services/market-broadcast.js";

const router = Router();
router.use(authMiddleware);

router.get("/status", (_req, res) => {
  res.json(getBroadcastStatus());
});

export default router;
