/**
 * IPS underperform threshold as **percentage points** (policy: lag > 5%).
 * Stored config is historically a signed ratio (`-0.05`) or a percent (`5`).
 */
export function underperformThresholdPct(raw: number): number {
  const abs = Math.abs(Number(raw) || 0);
  if (abs > 0 && abs < 1) return abs * 100;
  return abs;
}

/** `portRetPct` / `idxRetPct` are percent (e.g. 2.5 = 2.5%). Alert when lag exceeds the IPS threshold. */
export function lagsBenchmarkBeyondThreshold(
  portRetPct: number,
  idxRetPct: number,
  rawThreshold: number,
): boolean {
  const underBy = idxRetPct - portRetPct;
  return underBy > underperformThresholdPct(rawThreshold);
}
