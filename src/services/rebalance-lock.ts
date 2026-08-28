/** Live lock graph from `routes/rebalances.ts` (must match `06-BUSINESS-RULES.md` §7 except cancelled-from-executed — see tests). */
export type RebalanceLockStatus = "draft" | "approved" | "executed" | "final" | "cancelled";
export type RebalanceLockTarget = "approved" | "executed" | "final" | "cancelled";

export const REBALANCE_TRANSITIONS: Record<RebalanceLockTarget, RebalanceLockStatus[]> = {
  approved: ["draft"],
  executed: ["approved"],
  final: ["executed", "approved"],
  cancelled: ["draft", "approved"],
};

export function canTransitionRebalance(from: string, to: RebalanceLockTarget): boolean {
  if (from === "final") return false;
  return REBALANCE_TRANSITIONS[to].includes(from as RebalanceLockStatus);
}
