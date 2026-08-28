# 01 — Phase 1 Requirements

**Authority:** Blueprint §§1–8, 12–14, 17, 20–21 · QSC_Phase1 brief · PSA Annex C  
**Audience:** Developer + QSC Investment Management for requirements validation

---

## 1. Functional requirements by module

### FR-M1 Client Mandates

| ID | Requirement | Priority |
|----|-------------|----------|
| M1.1 | Create/edit client with mandate profile before any trading activity | Must |
| M1.2 | Mandate type = Discretionary only (IPS scope) | Must |
| M1.3 | Shariah preference: Fully Shariah / Shariah + Purifying / Unrestricted | Must |
| M1.4 | Risk profile: Medium / High | Must |
| M1.5 | Benchmark auto-map: QERI for Shariah mandates; DSM for Unrestricted | Must |
| M1.6 | Client-specific restrictions (stock/sector/other) stored and enforced | Must |
| M1.7 | Approval status: Pending / Approved / Amended / Closed | Must |
| M1.8 | Block all trade proposals and builder save-as-rebalance if status ≠ Approved | Must |
| M1.9 | Mandate change creates audit entry + approval trail | Must |
| M1.10 | Map mandate → eligible stock groups (A / A+B / A+B+C) and model construction type | Must |

### FR-M2 Stock Master

| ID | Requirement | Priority |
|----|-------------|----------|
| M2.1 | Single master table for QSE stocks | Must |
| M2.2 | Shariah group A / B / C on each stock | Must |
| M2.3 | Sector classification | Must |
| M2.4 | Benchmark membership flags (QERI, DSM) + optional constituent weight | Must |
| M2.5 | Liquidity flag when ADTV < QAR 100,000 | Must |
| M2.6 | Regulatory / QFMA status; block new exposure when restricted | Must |
| M2.7 | Admin UI + bulk import to maintain tags | Must |
| M2.8 | Eligibility service: given mandate + stock → allow/deny + reason | Must |
| M2.9 | Retain existing price history, adjusted prices, CA records | Must |

### FR-M3 Portfolio Manager

| ID | Requirement | Priority |
|----|-------------|----------|
| M3.1 | Multi-portfolio cockpit: NAV, cash, return, risk flags, pending actions | Must |
| M3.2 | Filters: Shariah, risk, PM/owner, breach status, mandate status | Must |
| M3.3 | Drill-down to Client Portfolio | Must |
| M3.4 | Surface open compliance exceptions and risk breaches | Must |
| M3.5 | Firm-level summary (AUM, #clients, #breaches) — can extend existing dashboard | Should |

### FR-M4 Client Portfolios

| ID | Requirement | Priority |
|----|-------------|----------|
| M4.1 | Client summary: name, account, mandate, benchmark, model, Shariah, risk, approval | Must |
| M4.2 | Valuation: NAV, invested value, cash, accrued dividends (basic), unsettled (stub OK) | Must |
| M4.3 | Performance: MTD, QTD, YTD, since inception vs benchmark (extend existing TWAR) | Must |
| M4.4 | Risk panel: concentration, sector exposure, open alerts | Must |
| M4.5 | Holdings: ticker, shares, MV, weight, cost, unrealized P&L | Must |
| M4.6 | Actions: pending rebalance, breaches, approvals | Must |
| M4.7 | Cash ledger (deposits/withdrawals) affecting NAV | Must |

### FR-M5 Portfolio Builder

| ID | Requirement | Priority |
|----|-------------|----------|
| M5.1 | Index Reference: DSM/QERI constituents, weights, sectors, prices | Must |
| M5.2 | Build: core/satellite or full active weights by stock/sector | Must |
| M5.3 | Medium: 65% core (benchmark-weighted) + 35% satellite (3–5 equal weight) | Must |
| M5.4 | High: 100% active under IPS limits | Must |
| M5.5 | Review: totals, splits, stock count, sector/stock limits, universe compliance | Must |
| M5.6 | Save model or client target version | Must |
| M5.7 | Print / export client-ready portfolio report (PDF or print CSS) | Should |
| M5.8 | Generate proposed trades (current → target) without OMS execution | Must |

### FR-M6 Rebalance History

| ID | Requirement | Priority |
|----|-------------|----------|
| M6.1 | Unique Rebalance ID per event | Must |
| M6.2 | Fields: client/model, timestamps, trigger, before/after snapshots, target, proposed trades, compliance, approval, lock status | Must |
| M6.3 | Triggers: quarterly, benchmark change, active review, breach, cash in/out, ad hoc | Must |
| M6.4 | Lock statuses: Draft / Approved / Executed / Final / Cancelled | Must |
| M6.5 | Final records immutable except controlled correction log | Must |
| M6.6 | Filter, view, compare, print | Must |
| M6.7 | Execution/allocation fields present as nullable Phase-2 stubs | Should |

### FR-M7 Compliance

| ID | Requirement | Priority |
|----|-------------|----------|
| M7.1 | Separate from Risk Monitor | Must |
| M7.2 | Checks: mandate classification, Shariah universe, stock/sector limits, cash, regulatory, exception approval | Must |
| M7.3 | Run before proposal and before save/approve of rebalance (Phase 1 timing) | Must |
| M7.4 | Pass/fail with reason codes | Must |
| M7.5 | Exception workflow: reason, approver, expiry, audit | Must |
| M7.6 | Compliance dashboard of open items | Must |

### FR-M8 Risk Monitor

| ID | Requirement | Priority |
|----|-------------|----------|
| M8.1 | Single stock >15% notify / prevent buy; >20% reduce to 15% in 10 trading days | Must |
| M8.2 | Sector >35% prevent buys; >40% reduce to 35% in 5 days | Must |
| M8.3 | Loss ladders −15% / −25% / −30% with review timelines | Must |
| M8.4 | Underperform benchmark >5% over rolling 3M → attribution due in 2 weeks (ticket/alert) | Must |
| M8.5 | Excess cash policy alert | Must |
| M8.6 | Alert list on Portfolio Manager + Client Portfolio | Must |
| M8.7 | Breach workflow: status, owner, due date, resolution | Must |

### FR-M9 Audit Trail

| ID | Requirement | Priority |
|----|-------------|----------|
| M9.1 | Immutable log: time, user, action, object type/id, old→new, reason, approval ref | Must |
| M9.2 | Cover mandate, stock master, builder save, rebalance transitions, compliance exceptions, risk resolutions, user admin | Must |
| M9.3 | Search/filter UI | Must |
| M9.4 | Basic system health: DB connectivity, last price refresh time | Should |
| M9.5 | AI governance note: AI analysis-only (document; no trade/fee/compliance override) | Should |

---

## 2. Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR.1 | Web-based; reuse current React + Express stack |
| NFR.2 | Authenticated APIs (JWT); role-aware authorization for approvals |
| NFR.3 | PostgreSQL single source of truth — no parallel Excel as system of record |
| NFR.4 | All money/weights use numeric precision suitable for QAR (prefer `numeric` in DB) |
| NFR.5 | Audit writes must not be deletable via application API |
| NFR.6 | Arabic labels optional in Phase 1 UI; data model supports bilingual display names where useful |
| NFR.7 | Performance: Portfolio Manager list usable for dozens of portfolios (pagination/filters) |

---

## 3. Explicit out-of-scope (Phase 1)

- Live broker OMS / order routing  
- Block order aggregation and fair allocation engines  
- Full five-layer research checklist UI (store Approved List status stub only if needed for compliance)  
- Fee calculation / monthly close automation (F-02, F-06) — schema hooks only  
- Client-facing portals  
- Mobile apps  

---

## 4. Requirements traceability

| Blueprint section | Phase 1 docs |
|-------------------|--------------|
| §5 Mandate | FR-M1, BUSINESS-RULES, modules/01 |
| §6 Stock master | FR-M2, modules/02 |
| §7 Models / core-satellite | FR-M5, BUSINESS-RULES |
| §8 / §8.1 Builder + History | FR-M5, FR-M6 |
| §12 Risk | FR-M8 |
| §13 Compliance | FR-M7 |
| §14 Client portfolio | FR-M4 |
| §17 Admin & Audit | FR-M9 |
| §20 Phasing | This phase boundary |
