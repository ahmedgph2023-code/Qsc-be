/**
 * Money helpers (FIN-03 interim).
 * Schema stores `numeric` as strings; engines still use JS number for arithmetic.
 * Always round through these helpers at money boundaries until a decimal library is adopted.
 */

export const QAR_SCALE = 4;
export const QAR_DISPLAY_SCALE = 2;

export function roundMoney(n: number, scale = QAR_SCALE): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** scale;
  return Math.round(n * f) / f;
}

export function roundQar2(n: number): number {
  return roundMoney(n, QAR_DISPLAY_SCALE);
}

export function toMoneyNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Safe sum of money amounts with fixed-scale rounding. */
export function sumMoney(values: unknown[], scale = QAR_SCALE): number {
  let s = 0;
  for (const v of values) s = roundMoney(s + toMoneyNumber(v), scale);
  return s;
}
