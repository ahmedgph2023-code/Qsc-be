/** Phase 6 — unsigned PortfolioValue / bank / role questions. Display only. */

export type BalanceQuestionRow = {
  id: string;
  handoverQuestion: number | null;
  codeToday: string;
  status: "blocked";
};

export function listBalanceOpenQuestions(): BalanceQuestionRow[] {
  return [
    { id: "P6-PV", handoverQuestion: 4, status: "blocked", codeToday: "QSC PortfolioValue is compared to IPMS MV and to MV+cash (tolerance 0.01 QAR). Neither column is a signed NAV. cash_only is not a PV sign-off." },
    { id: "P6-BANK", handoverQuestion: null, status: "blocked", codeToday: "QSC BankBalance is shown from SQL only. IPMS bank source is UNKNOWN. Do not invent a bank ledger." },
    { id: "P6-ROLE", handoverQuestion: null, status: "blocked", codeToday: "Four QSC job titles map to existing roles (pm / admin / viewer). No new accountant role until signed." },
    { id: "P6-CLOSES", handoverQuestion: 22, status: "blocked", codeToday: "Official closes in IPMS stop at 2026-08-19. Snapshot MV for 27–28 Aug stays incomplete until those closes exist." },
  ];
}

export function getBalanceQuestionBoard() {
  return {
    signed: false as const,
    inventBankLedger: false as const,
    addAccountantRole: false as const,
    rows: listBalanceOpenQuestions(),
  };
}
