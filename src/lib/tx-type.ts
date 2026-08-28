export type StockTxType = "BUY" | "SELL" | "CLIENT_TRANSFER";

function normSide(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function isSell(type: string): boolean {
  return String(type).toUpperCase() === "SELL";
}

/** BUY and CLIENT_TRANSFER increase quantity; SELL decreases it. */
export function qtyDelta(type: string, quantity: number): number {
  const q = Number(quantity) || 0;
  return isSell(type) ? -q : q;
}

export function isEquityTransferOut(raw: unknown): boolean {
  const t = normSide(raw);
  return t === "EQUITY_TRANSFER_OUT" || t === "TRANSFER_OUT" || t === "EQUITYTRANSFEROUT";
}

export function isEquityTransferIn(raw: unknown): boolean {
  const t = normSide(raw);
  return (
    t === "CLIENT_TRANSFER" ||
    t === "TRANSFER_IN" ||
    t === "EQUITY_TRANSFER_IN" ||
    t === "CLIENTTRANSFER" ||
    t === "EQUITYTRANSFERIN"
  );
}

export function parseStockTxType(raw: unknown): StockTxType {
  const t = normSide(raw);
  if (t === "SELL" || isEquityTransferOut(raw)) return "SELL";
  if (isEquityTransferIn(raw)) return "CLIENT_TRANSFER";
  if (t === "BUY") return "BUY";
  return "BUY";
}

export function isClientTransferRow(raw: unknown): boolean {
  return parseStockTxType(raw) === "CLIENT_TRANSFER" && !isCashTransferRow(raw);
}

export function isCashTransferRow(raw: unknown): boolean {
  const t = normSide(raw);
  return t === "TRANSFER" || t === "WITHDRAWAL";
}

/** In-kind share move: no cash, no realized P/L. Detect from type or P&L Order Side notes. */
export function isInKindShareMove(type: string, notes?: string | null): boolean {
  if (type === "CLIENT_TRANSFER" || isEquityTransferIn(type) || isEquityTransferOut(type)) return true;
  const n = String(notes ?? "").toLowerCase();
  return /equity\s*transfer/.test(n);
}
