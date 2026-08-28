import cron from "node-cron";
import { scanAllPortfoliosRisk } from "./risk-engine.js";

/**
 * Scheduled risk scan (audit M8). Disabled unless RISK_CRON_ENABLED=true.
 * Underperform-vs-benchmark remains a placeholder inside risk-engine until BD-004/BD-007.
 */
export function startRiskCron() {
  if (process.env.RISK_CRON_ENABLED !== "true") {
    console.log("[risk] Daily scan cron disabled (set RISK_CRON_ENABLED=true to activate)");
    return;
  }
  cron.schedule("30 16 * * 1-5", async () => {
    console.log("[risk] Cron scanning all portfolios");
    try {
      const result = await scanAllPortfoliosRisk();
      console.log("[risk] Cron done:", result);
    } catch (err: any) {
      console.error("[risk] Cron failed:", err?.message || err);
    }
  }, { timezone: "Asia/Qatar" });
  console.log("[risk] Daily scan cron enabled (16:30 Asia/Qatar weekdays)");
}
