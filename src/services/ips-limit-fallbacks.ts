/**
 * Fallback IPS numbers when `ips_limit_config` has no row.
 * Must stay aligned with `06-BUSINESS-RULES.md` §5 and `seed.ts` IPS_LIMITS.
 */
export const IPS_LIMIT_FALLBACKS = {
  stockSoft: 0.15,
  stockHard: 0.2,
  sectorSoft: 0.35,
  sectorHard: 0.4,
  loss15: -0.15,
  loss25: -0.25,
  loss30: -0.3,
  underperform: -0.05,
  excessCash: 0.1,
  daysStock20: 10,
  daysSector40: 5,
} as const;
