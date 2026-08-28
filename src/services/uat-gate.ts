/** Phase 9 — UAT waiting room. Do not run 09-ACCEPTANCE or unlock later-phase routes. */

export type UatBlockerRow = {
  id: string;
  handoverQuestion: number | null;
  codeToday: string;
  status: "blocked";
};

export function listUatBlockers(): UatBlockerRow[] {
  return [
    { id: "P1-CLOSES", handoverQuestion: 22, status: "blocked", codeToday: "Official closes in IPMS stop at 2026-08-19. UAT that needs as-of MV after that date cannot pass." },
    { id: "P2-FOOTER", handoverQuestion: 1, status: "blocked", codeToday: "Statement footer formulas are blank until questions 1–8 and 13–14 are signed." },
    { id: "P8-PRODUCT", handoverQuestion: 27, status: "blocked", codeToday: "09 B1/B4 still describe Shariah Groups A/B/C. Runtime is binary 0008. Do not treat the list as passed." },
    { id: "P9-SIGN-OFF", handoverQuestion: null, status: "blocked", codeToday: "No named QSC owner has signed 09-ACCEPTANCE-CRITERIA.md. August 2026 % reports are historical, not completion." },
    { id: "P10-LOCKED", handoverQuestion: null, status: "blocked", codeToday: "OMS, fees UI, fixed income, research, and AI routes stay locked. Next.js is forbidden (D-001)." },
  ];
}

export function getUatBoard() {
  return {
    runnable: false as const,
    phase1Accepted: false as const,
    gapAnalysisIsNotStatus: true as const,
    laterPhaseRoutesLocked: true as const,
    rows: listUatBlockers(),
  };
}
