# QSC IPMS — Phase 1 Plans

**Project:** Investment Portfolio Management System (IPMS) for Qatar Co. for Securities (QSC)  
**Phase:** Phase 1 — Core Operations  
**Owner:** Single developer (M) — dual-developer split in `QSC_Phase1.docx` is **deprecated**  
**Target stack:** `qse-back` (Express + Drizzle + PostgreSQL) · `qse-front` (React + Vite portfolio-dashboard)  
**Primary specification:** [QSC Integrated Investment Management System Blueprint](../../regulatory%20documents/Investment%20system%20(2).docx) (11 June 2026)  
**Contractual anchor:** PSA Annex A (SOW) + Annex C (Blueprint as F&T requirements)

---

## Purpose of this folder

These documents are the **working plan to finalize Phase 1**. They replace informal meeting notes and the obsolete two-developer work-split. Use them as the single source of truth for scope, schema, APIs, UI, rules, and acceptance.

## Document map

| # | Document | Use when |
|---|----------|----------|
| 00 | [PHASE1-OVERVIEW.md](./00-PHASE1-OVERVIEW.md) | Orienting anyone on what Phase 1 is and is not |
| 01 | [REQUIREMENTS.md](./01-REQUIREMENTS.md) | Validating functional requirements vs Blueprint |
| 02 | [MODULES.md](./02-MODULES.md) | Building or reviewing each of the 9 modules |
| 03 | [DATABASE-SCHEMA.md](./03-DATABASE-SCHEMA.md) | Designing / migrating PostgreSQL + Drizzle |
| 04 | [API-SPEC.md](./04-API-SPEC.md) | Implementing REST endpoints |
| 05 | [FRONTEND-SPEC.md](./05-FRONTEND-SPEC.md) | Building dashboard screens & navigation |
| 06 | [BUSINESS-RULES.md](./06-BUSINESS-RULES.md) | Coding mandate, Shariah, risk, compliance engines |
| 07 | [WORKFLOWS.md](./07-WORKFLOWS.md) | End-to-end user journeys |
| 08 | [IMPLEMENTATION-PLAN.md](./08-IMPLEMENTATION-PLAN.md) | Sequencing work as one developer |
| 09 | [ACCEPTANCE-CRITERIA.md](./09-ACCEPTANCE-CRITERIA.md) | Declaring Phase 1 done / UAT checklist |
| 10 | [GAP-ANALYSIS.md](./10-GAP-ANALYSIS.md) | Mapping current code → Phase 1 target |
| 11 | [DATA-MIGRATION.md](./11-DATA-MIGRATION.md) | Evolving existing tables without data loss |
| 12 | [SECURITY-RBAC.md](./12-SECURITY-RBAC.md) | Users, roles, approvals, audit |
| 13 | [OPS-FORMS-MAPPING.md](./13-OPS-FORMS-MAPPING.md) | Arabic ops forms F-01–F-06 vs Phase 1/2 |
| 14 | [TECHNICAL-ARCHITECTURE.md](./14-TECHNICAL-ARCHITECTURE.md) | System architecture & conventions |
| 15 | [SOURCE-TRACEABILITY.md](./15-SOURCE-TRACEABILITY.md) | Map regulatory docs → plan files |
| 16 | [RUNBOOK.md](./16-RUNBOOK.md) | How to migrate, seed, and demo Phase 1 |

### Per-module deep dives

| Module | File |
|--------|------|
| Client Mandates | [modules/01-client-mandates.md](./modules/01-client-mandates.md) |
| Stock Master | [modules/02-stock-master.md](./modules/02-stock-master.md) |
| Portfolio Manager | [modules/03-portfolio-manager.md](./modules/03-portfolio-manager.md) |
| Client Portfolios | [modules/04-client-portfolios.md](./modules/04-client-portfolios.md) |
| Portfolio Builder | [modules/05-portfolio-builder.md](./modules/05-portfolio-builder.md) |
| Rebalance History | [modules/06-rebalance-history.md](./modules/06-rebalance-history.md) |
| Compliance | [modules/07-compliance.md](./modules/07-compliance.md) |
| Risk Monitor | [modules/08-risk-monitor.md](./modules/08-risk-monitor.md) |
| Audit Trail | [modules/09-audit-trail.md](./modules/09-audit-trail.md) |

## Source regulatory documents

| Document | Role |
|----------|------|
| `regulatory documents/Investment system (2).docx` | Blueprint — Phase 1 module list + IPS rules |
| `regulatory documents/QSC_Phase1.docx` | Meeting brief (explainers); **team split obsolete** |
| `regulatory documents/PROFESSIONAL SERVICES AGREEMENT….docx` | PSA, SOW, Annex C |
| `regulatory documents/الإجراءات التشغيلية….docx` | Ops procedures + forms F-01–F-06 |

Text extracts (for searchability): `.tmp_docs_extract/`

## Phase 1 module checklist (Blueprint §20)

1. Client Mandates  
2. Stock Master  
3. Portfolio Manager  
4. Client Portfolios  
5. Portfolio Builder  
6. Rebalance History  
7. Compliance  
8. Risk Monitor  
9. Audit Trail  

**Out of Phase 1 (do not expand scope):** Trade Simulator, OMS, Block Orders, Allocation, Corporate Actions (ops depth), Performance/AUM/IC reports, Market Overview/Screener, Efficient Frontier, AI Assistant.

> Note: The current codebase already has partial corporate actions and sector AI. Keep them; do not treat them as Phase 1 blockers or Phase 1 scope expansion.

## Core operating principle (Blueprint §2)

> One investment decision → controlled proposed trades across affected portfolios → automatic compliance → approval → execution tracking → fair allocation → post-trade review → locked rebalance history → audit.

Phase 1 implements this through **proposal + compliance + history**, not full OMS (Phase 2).
