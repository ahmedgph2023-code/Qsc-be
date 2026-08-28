/**
 * Sector AI pipeline used to run on a 30-minute cron.
 * Disabled — analysis only runs from the Sectors UI "Fetch News & Analyze" button
 * (POST /api/sectors/refresh and related routes).
 */
export function startScheduler() {
  console.log("[scheduler] Sector cron disabled — use manual refresh only");
}
