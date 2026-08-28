/** Cash ledger stores amount as a positive abs value; type decides the sign vs cash_balance. */
export const CASH_DEBIT_TYPES = new Set(["withdrawal", "fee", "trade_buy"]);

export function signedCashDelta(type: string, amount: number): number {
  const abs = Math.abs(Number(amount) || 0);
  return CASH_DEBIT_TYPES.has(type) ? -abs : abs;
}

function ledgerDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

/**
 * Cash(D) contract used by `getCashBalanceAsOf`: sum signed ledger rows with
 * `tradeDate <= asOf`, then round 4 dp. Opening cash is a deposit (or other credit) row.
 */
export function sumCashLedgerAsOf(
  rows: Array<{ type: string; amount: unknown; tradeDate: unknown }>,
  asOf: string,
): number {
  let bal = 0;
  for (const r of rows) {
    if (ledgerDate(r.tradeDate) > asOf) continue;
    bal += signedCashDelta(r.type, Number(r.amount ?? 0));
  }
  return Math.round(bal * 10000) / 10000;
}
