/**
 * Phase 7 live broadcast — status only until QSC URL + JSON samples exist.
 * Must not connect. Must not write stock_prices (statements stay on official close).
 */

export const BROADCAST_OBJECT_NAMES = [
  "exchange_summary",
  "market_watch",
  "trades",
  "market_depth",
  "indices",
] as const;

export type BroadcastBlockedReason = "NO_BROADCAST_WS_URL" | "NO_JSON_SAMPLE";

export type BroadcastStatus = {
  configured: boolean;
  connected: false;
  ingestOfficialCloses: false;
  valuationSource: "official_close";
  objectsNamedByQsc: typeof BROADCAST_OBJECT_NAMES[number][];
  blockedReason: BroadcastBlockedReason;
};

export function isBroadcastUrlConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.BROADCAST_WS_URL || "").trim());
}

export function getBroadcastStatus(env: NodeJS.ProcessEnv = process.env): BroadcastStatus {
  const configured = isBroadcastUrlConfigured(env);
  return {
    configured,
    connected: false,
    ingestOfficialCloses: false,
    valuationSource: "official_close",
    objectsNamedByQsc: [...BROADCAST_OBJECT_NAMES],
    blockedReason: configured ? "NO_JSON_SAMPLE" : "NO_BROADCAST_WS_URL",
  };
}

export function startMarketBroadcast(): void {
  const status = getBroadcastStatus();
  console.log(`[live] Broadcast idle (${status.blockedReason}) — will not connect; will not write stock_prices`);
}
