/**
 * QSE instrument ticker classification.
 *
 * Debt / fixed income (included in FI module):
 *   GA## government bonds, TE## T-bills,
 *   SA## sukuk, TA##/TB##/TC## other debt series,
 *   CA##/KA## par-priced debt-like series
 * Rights (still excluded from equity + FI):
 *   R0## equity rights issues
 */

export type FiInstrumentKind = "gov_bond" | "t_bill" | "sukuk" | "other_debt";

export function isQseRightsTicker(ticker: string): boolean {
  return /^R0\d+$/i.test(ticker.trim());
}

export function isQseFixedIncomeTicker(ticker: string): boolean {
  return /^(GA|TE|SA|TA|TB|TC|CA|KA)\d+$/i.test(ticker.trim());
}

/** @deprecated use isQseFixedIncomeTicker / isQseRightsTicker */
export function isQseDebtTicker(ticker: string): boolean {
  return isQseFixedIncomeTicker(ticker) || isQseRightsTicker(ticker);
}

export function fiKindFromTicker(ticker: string): FiInstrumentKind | null {
  const t = ticker.trim().toUpperCase();
  if (/^GA\d+$/.test(t)) return "gov_bond";
  if (/^TE\d+$/.test(t)) return "t_bill";
  if (/^SA\d+$/.test(t)) return "sukuk";
  if (/^(TA|TB|TC|CA|KA)\d+$/.test(t)) return "other_debt";
  return null;
}

export function defaultCouponFrequency(kind: FiInstrumentKind): "zero" | "semi_annual" {
  return kind === "t_bill" ? "zero" : "semi_annual";
}
