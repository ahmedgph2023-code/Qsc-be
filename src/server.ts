import "dotenv/config";
import app from "./app.js";
import { seed } from "./db/seed.js";
import { syncIndexMembershipFlags } from "./services/index-membership.js";

import { startFeeCron } from "./services/fee-cron.js";
import { startRiskCron } from "./services/risk-cron.js";
import { startSnapshotCron } from "./services/snapshot-cron.js";
import { startMarketBroadcast } from "./services/market-broadcast.js";

const PORT = parseInt(process.env.PORT || "5001", 10);

/** SEC-01: production never auto-seeds; local seeds unless SKIP_SEED=1. Opt-in anytime via RUN_SEED=1. */
function shouldRunSeed(): boolean {
  if (process.env.SKIP_SEED === "1") return false;
  if (process.env.RUN_SEED === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

if (shouldRunSeed()) {
  await seed();
} else {
  console.log("[startup] Skipping database seed (production default, or SKIP_SEED=1)");
}

try {
  const membership = await syncIndexMembershipFlags();
  console.log(`[startup] Synced index membership flags: QERI=${membership.qeriMembers} DSM=${membership.dsmMembers}`);
} catch (err: any) {
  console.warn("[startup] Index membership sync skipped:", err?.message || err);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
  startFeeCron();
  startRiskCron();
  startSnapshotCron();
  startMarketBroadcast();
});
