import cron from "node-cron";
import { todayQatar } from "./fee-engine.js";
import { runDailySnapshot } from "./snapshot-recon.js";

/** After QSC 15:00 snapshot. Disabled unless SNAPSHOT_CRON_ENABLED=true. */
export function startSnapshotCron() {
  if (process.env.SNAPSHOT_CRON_ENABLED !== "true") {
    console.log("[snapshots] Daily compare cron disabled (set SNAPSHOT_CRON_ENABLED=true to activate)");
    return;
  }
  cron.schedule("15 15 * * 1-5", async () => {
    const asOf = todayQatar();
    console.log(`[snapshots] Cron comparing SQL vs IPMS for ${asOf}`);
    try {
      const result = await runDailySnapshot(asOf, null);
      console.log("[snapshots] Cron done:", result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[snapshots] Cron failed:", message);
    }
  }, { timezone: "Asia/Qatar" });
  console.log("[snapshots] Daily compare cron enabled (15:15 Asia/Qatar weekdays)");
}
