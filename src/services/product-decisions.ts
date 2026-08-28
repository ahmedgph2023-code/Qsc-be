/** Phase 8 — open product decisions. Display only. Do not treat a row as signed. */

export type ProductDecisionStatus = "blocked";

export type ProductDecisionRow = {
  id: string;
  handoverQuestion: number | null;
  codeToday: string;
  status: ProductDecisionStatus;
};

export function listOpenProductDecisions(): ProductDecisionRow[] {
  return [
    { id: "BD-001", handoverQuestion: 27, status: "blocked", codeToday: "Binary shariah | not_shariah (migration 0008). Purifying mandates treated as unrestricted. Do not revert A/B/C without sign-off." },
    { id: "BD-002", handoverQuestion: null, status: "blocked", codeToday: "restricted/suspended block new buys. watch is stored with no gate. No official QFMA map." },
    { id: "BD-003", handoverQuestion: 28, status: "blocked", codeToday: "Postgres demo book is 1 customer = 1 portfolio = 1 mandate. SQL sample uses Client ID vs Account ID." },
    { id: "BD-004", handoverQuestion: 29, status: "blocked", codeToday: "Screen return is labelled unofficial (holdings vs net share cash). Not signed TWR/MWR." },
    { id: "BD-005", handoverQuestion: 30, status: "blocked", codeToday: "Fee charges generate pending; approver/admin post cash. Cron does not auto-approve. F-02 is still Phase 2 governance." },
    { id: "BD-006", handoverQuestion: 4, status: "blocked", codeToday: "Statement NAV footer stays unknown. Screen NAV is holdings+cash. PDF Dr/Cr vs cash is unsigned." },
    { id: "BD-007", handoverQuestion: 31, status: "blocked", codeToday: "IPS due dates use calendar days (including Fri/Sat) via UTC ISO date. No QSE holiday list in repo." },
    { id: "BD-008", handoverQuestion: 5, status: "blocked", codeToday: "KB 31/12/2024 GISS checked. 2025/2026 period statements not in KB markdown." },
    { id: "BD-009", handoverQuestion: 15, status: "blocked", codeToday: "Sample investor contract files are empty. Do not invent fee rates." },
    { id: "BD-010", handoverQuestion: null, status: "blocked", codeToday: "Exception approver is unconfirmed. Fee approve uses approver/admin, not the compliance role." },
    { id: "BD-011", handoverQuestion: null, status: "blocked", codeToday: "Proposed qty is Math.floor(notional/price). No QSE lot-size table in schema." },
    { id: "Q-16", handoverQuestion: 16, status: "blocked", codeToday: "No sample-investor mandate card in SQL. IPS screens use policy/seed, not this client’s signed card." },
    { id: "Q-18", handoverQuestion: 18, status: "blocked", codeToday: "Historical index constituents/weights were requested; not stored as separate KB files." },
    { id: "Q-19", handoverQuestion: 19, status: "blocked", codeToday: "Bonus/split/dividend exist. Rights/merger are rejected until a product decision." },
  ];
}

export function getProductDecisionBoard() {
  return {
    signed: false as const,
    rows: listOpenProductDecisions(),
  };
}
