import cron from "node-cron";
import { generateFeeChargesForMonth, previousMonth, todayQatar } from "./fee-engine.js";

export function startFeeCron() {
  if (process.env.FEE_CRON_ENABLED !== "true") {
    console.log("[fees] Month-end cron disabled (set FEE_CRON_ENABLED=true to activate)");
    return;
  }
  cron.schedule("0 2 1 * *", async () => {
    const ym = previousMonth(todayQatar().slice(0, 7));
    console.log(`[fees] Cron generating pending charges for ${ym}`);
    try {
      const results = await generateFeeChargesForMonth(ym);
      console.log(`[fees] Cron done for ${ym}: ${results.length} portfolios`);
    } catch (err: any) {
      console.error("[fees] Cron failed:", err?.message || err);
    }
  }, { timezone: "Asia/Qatar" });
  console.log("[fees] Month-end cron enabled (02:00 Asia/Qatar on the 1st)");
}
