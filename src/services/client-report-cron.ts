import cron from "node-cron";
import { runDueClientReports } from "./client-report-engine.js";

/** Checks every minute for due client reports. Disabled unless CLIENT_REPORT_CRON_ENABLED=true. */
export function startClientReportCron() {
  if (process.env.CLIENT_REPORT_CRON_ENABLED !== "true") {
    console.log("[client-reports] Scheduled send cron disabled (set CLIENT_REPORT_CRON_ENABLED=true to activate)");
    return;
  }
  cron.schedule("* * * * *", async () => {
    try {
      const results = await runDueClientReports();
      const sent = results.filter((r) => r.ok).length;
      if (sent > 0) console.log(`[client-reports] Sent ${sent} scheduled report(s)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[client-reports] Cron failed:", message);
    }
  }, { timezone: "Asia/Qatar" });
  console.log("[client-reports] Scheduled send cron enabled (every minute, Asia/Qatar)");
}
