# 09 — Acceptance Criteria (Phase 1 UAT)

Phase 1 is **accepted** only when all Must items pass. Should items may be waived in writing.

---

## A. Client Mandates

| # | Criterion | Pass |
|---|-----------|------|
| A1 | Can create customer + mandate with all mandatory fields | ☐ |
| A2 | Invalid combinations rejected (e.g. missing Shariah) | ☐ |
| A3 | Benchmark auto-set QERI vs DSM by Shariah preference | ☐ |
| A4 | Status Pending blocks BUY/SELL and builder convert | ☐ |
| A5 | Approver can Approve; then trading allowed | ☐ |
| A6 | Restrictions block prohibited stock in compliance | ☐ |
| A7 | Status changes appear in audit | ☐ |

## B. Stock Master

| # | Criterion | Pass |
|---|-----------|------|
| B1 | Stocks show Group A/B/C, liquidity, regulatory | ☐ |
| B2 | Illiquid flag when ADTV < 100,000 | ☐ |
| B3 | Restricted stock cannot be added as new BUY | ☐ |
| B4 | Fully Shariah mandate cannot target Group B/C | ☐ |
| B5 | Index constituents available for QERI and DSM | ☐ |

## C. Portfolio Manager

| # | Criterion | Pass |
|---|-----------|------|
| C1 | Lists all active portfolios with NAV, cash, flags | ☐ |
| C2 | Filters by Shariah, risk, breach work | ☐ |
| C3 | Drill-down opens client portfolio | ☐ |

## D. Client Portfolios

| # | Criterion | Pass |
|---|-----------|------|
| D1 | Summary shows mandate + model + benchmark | ☐ |
| D2 | Valuation shows NAV, invested, cash | ☐ |
| D3 | Holdings with weights and P&L | ☐ |
| D4 | Performance MTD/QTD/YTD/SI vs benchmark | ☐ |
| D5 | Cash deposit/withdrawal updates balance | ☐ |
| D6 | Open risk/compliance actions visible | ☐ |

## E. Portfolio Builder

| # | Criterion | Pass |
|---|-----------|------|
| E1 | Index Reference loads constituents + prices | ☐ |
| E2 | Medium portfolio enforces 65/35 and 3–5 satellite | ☐ |
| E3 | High portfolio allows full active under limits | ☐ |
| E4 | Review fails on universe/limit breaches | ☐ |
| E5 | Proposed trades generated from current→target | ☐ |
| E6 | Save model / convert to rebalance draft | ☐ |
| E7 | Print or print-preview works | ☐ Should |

## F. Rebalance History

| # | Criterion | Pass |
|---|-----------|------|
| F1 | Draft contains before snapshot + target + trades + compliance | ☐ |
| F2 | Approve / execute / finalize / cancel transitions enforced | ☐ |
| F3 | Final record not editable in place | ☐ |
| F4 | Correction log works on Final | ☐ |
| F5 | Filter/search/compare by client and date | ☐ |

## G. Compliance

| # | Criterion | Pass |
|---|-----------|------|
| G1 | Engine returns pass/fail with reason codes | ☐ |
| G2 | Exception request → approve → allows override | ☐ |
| G3 | Dashboard shows open exceptions/failures | ☐ |

## H. Risk Monitor

| # | Criterion | Pass |
|---|-----------|------|
| H1 | Stock >15% and >20% alerts created with due dates | ☐ |
| H2 | Sector >35% / >40% alerts | ☐ |
| H3 | Loss ladder alerts −15/−25/−30 | ☐ |
| H4 | Underperform 3M >5% alert | ☐ |
| H5 | Alerts visible on cockpit + client + risk page | ☐ |
| H6 | Resolve/waive with audit | ☐ |

## I. Audit Trail

| # | Criterion | Pass |
|---|-----------|------|
| I1 | Sensitive actions listed with user, time, old/new | ☐ |
| I2 | No API to delete audit rows | ☐ |
| I3 | Filter by object and date | ☐ |

## J. Cross-cutting

| # | Criterion | Pass |
|---|-----------|------|
| J1 | Demo dataset: ≥3 clients covering all Shariah prefs | ☐ |
| J2 | Role separation: PM cannot approve own mandate without Approver role | ☐ |
| J3 | No Critical/High defects open on Must paths | ☐ |
| J4 | Technical docs in `plans/phase-1` delivered | ☐ |

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer (M) | | | |
| QSC Investment Management | | | |
| QSC Compliance (if required) | | | |
