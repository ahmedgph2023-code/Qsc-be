# 00 — Phase 1 Overview

## What Phase 1 is

Phase 1 makes QSC’s discretionary equity management **operational and controlled**. It replaces Excel-and-memory workflows with:

| Capability | Outcome |
|------------|---------|
| Rules | Every client has an enforceable mandate (Shariah, risk, benchmark, restrictions) |
| Universe | Every QSE stock is tagged (Group A/B/C, liquidity, regulatory) |
| Visibility | Portfolio Manager + Client Portfolio screens for many portfolios at once |
| Construction | Portfolio Builder for model/client targets (core-satellite / full active) |
| Safety | Compliance (permission) + Risk Monitor (alerts) |
| Evidence | Locked Rebalance History + immutable Audit Trail |

**Mnemonic:** rules + portfolio view + rebalance workspace + safety brakes + records.

## What Phase 1 is not

| Deferred to | Modules |
|-------------|---------|
| Phase 2 | Trade Simulator, OMS, Block Orders, Fair Allocation, deep Corporate Actions ops, Performance/Fee/Client/AUM/IC reports |
| Phase 3 | Market Overview, Screener, Analytics, Company Analysis, Stock Scoring, Sharia & ESG research UI |
| Phase 4 | Efficient Frontier, AI Assistant (analysis-only if later enabled) |

Phase 1 **may** store placeholder fields for execution/allocation on rebalance records so Phase 2 plugs in without schema rewrite.

## Contractual framing

- **PSA Annex A:** Full IPMS SOW (~10 weeks for complete system). Phase 1 is the **first delivery slice** of that SOW aligned to Blueprint §20.
- **PSA Annex C:** Blueprint is the complete Functional & Technical Specification.
- **Arabic ops annex:** Fee calc, monthly close, contract renewal forms (F-01–F-06) — mostly **Phase 2 Performance & Fee**; Phase 1 only needs data foundations that those forms will later consume (NAV, cash, mandate status, audit of approvals).

## Single-developer operating model

The Phase 1 meeting brief assumed work split between two developers. **That is deprecated.** One developer (M) owns front + back end-to-end.

### Implications

1. **Vertical slices over horizontal layers** — deliver one complete module path (DB → API → UI → rules) before starting the next, not “all backend then all frontend.”
2. **Reuse existing foundation** — stocks, prices, customers, portfolios, transactions, dashboard, indices already exist; extend rather than rewrite.
3. **Strict scope control** — if a feature is Phase 2+, park it with a stub or ticket; do not build it mid–Phase 1.
4. **Approval roles can be soft in v1** — RBAC with PM / Compliance / Approver is required for auditability; same person may hold multiple roles in UAT, but the system must enforce status transitions.

Recommended delivery order is in [08-IMPLEMENTATION-PLAN.md](./08-IMPLEMENTATION-PLAN.md).

## Success definition (short)

Phase 1 is accepted when a portfolio manager can:

1. Create an **Approved** client mandate.  
2. Maintain a tagged **Stock Master**.  
3. See all portfolios in **Portfolio Manager** with risk/compliance flags.  
4. Open a **Client Portfolio** with NAV, cash, holdings, mandate, pending actions.  
5. Use **Portfolio Builder** to set targets, pass **Compliance**, and save a **Rebalance** with before/after snapshots.  
6. See **Risk** alerts for IPS breaches.  
7. Prove every sensitive change in **Audit Trail**.

Full checklist: [09-ACCEPTANCE-CRITERIA.md](./09-ACCEPTANCE-CRITERIA.md).

## Relationship to current product

The live app is a **portfolio tracker + sector AI intel**, not yet IPMS Phase 1.

| Area | Current | Phase 1 target |
|------|---------|----------------|
| Clients | name, email, join date | + full mandate profile |
| Stocks | ticker, name, sector string | + Shariah group, benchmarks, liquidity, regulatory |
| Portfolios | 1:1 customer, txs, TWAR | + cash, model link, NAV pack, risk/compliance panels |
| Builder / Rebalance / Compliance / Risk / Audit | absent | greenfield |

See [10-GAP-ANALYSIS.md](./10-GAP-ANALYSIS.md).

## Glossary (Phase 1)

| Term | Meaning |
|------|---------|
| Mandate | Contract profile: Shariah, risk, benchmark, restrictions, approval |
| Group A/B/C | Shariah universe tags on stocks |
| Model portfolio | Target template linked to mandate type (QERI/DSM × Medium/High) |
| Core-satellite | Medium risk: 65% benchmark core + 35% equal-weight satellite (3–5 names) |
| Full active | High risk: 100% active selection under IPS limits |
| Rebalance | Move holdings toward target; creates locked history event |
| Compliance | May this action proceed? |
| Risk | Is exposure/performance dangerous vs IPS? |
| NAV | Market value of assets − liabilities (holdings + cash − fees/liabilities) |
| IPS | Investment Policy Statement rules encoded in the system |
