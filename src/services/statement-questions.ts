/** Phase 2+3 — statement footer and movement questions. Display only. Do not fill formulas. */

export type StatementQuestionRow = {
  id: string;
  handoverQuestion: number;
  codeToday: string;
  status: "blocked";
};

export function listStatementOpenQuestions(): StatementQuestionRow[] {
  return [
    { id: "Q-01", handoverQuestion: 1, status: "blocked", codeToday: "Expected sell commission footer stays blank. Sample 1/12/2024 PDF showed 12,780.14 (~0.275% of MV). Not treated as a standing rule." },
    { id: "Q-02", handoverQuestion: 2, status: "blocked", codeToday: "Printed breakeven 1.924 vs cost 1.919. Formula UNKNOWN. Footer not filled." },
    { id: "Q-03", handoverQuestion: 3, status: "blocked", codeToday: "1/12/2024 SQL cash 170,494.61 equals PDF Dr/Cr. Printed client net cash 2,174,992.23 is not that column. Footer stays blank." },
    { id: "Q-04", handoverQuestion: 4, status: "blocked", codeToday: "Screen NAV is holdings+cash. Statement NAV footer is null until signed." },
    { id: "Q-05", handoverQuestion: 5, status: "blocked", codeToday: "Year-end GISS 31/12/2024 KB checked. Which document is reconstruction truth is unsigned." },
    { id: "Q-06", handoverQuestion: 6, status: "blocked", codeToday: "31/12/2025 and 30/07/2026 statements named in email are not in KB markdown." },
    { id: "Q-07", handoverQuestion: 7, status: "blocked", codeToday: "Realized-summary period is caller from/to. Whether it must be YTD or inception is unsigned." },
    { id: "Q-08", handoverQuestion: 8, status: "blocked", codeToday: "Received-profits and paid-capital footer cells stay null. Do not invent source tables." },
    { id: "Q-09", handoverQuestion: 9, status: "blocked", codeToday: "Live 37012/37013 are InvType=NI with B/S flags. Engine still treats them as sell then buy. Do not special-case until signed." },
    { id: "Q-10", handoverQuestion: 10, status: "blocked", codeToday: "On this sample: OI+B and OC+S dominate. NI has both sides. SP not seen here. Names are not a dictionary." },
    { id: "Q-11", handoverQuestion: 11, status: "blocked", codeToday: "Cash docs JV/PV/RV: dictionary does not map printed names. Sample has JV and PV; RV=0." },
    { id: "Q-13", handoverQuestion: 13, status: "blocked", codeToday: "UAT identity is NIN 37808 / Client 1800101035339 / Account 2041929. Do not numerically UAT a different person’s PDF." },
    { id: "Q-14", handoverQuestion: 14, status: "blocked", codeToday: "Print uses the browser dialog. No dedicated PDF library until QSC requires one." },
  ];
}

export function getStatementQuestionBoard() {
  return {
    signed: false as const,
    fillFooter: false as const,
    changeNiEngine: false as const,
    rows: listStatementOpenQuestions(),
  };
}
