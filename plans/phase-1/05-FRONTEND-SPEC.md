# 05 — Frontend Specification (Phase 1)

**App:** `qse-front/artifacts/portfolio-dashboard`  
**Router:** wouter · **Data:** TanStack Query · **UI:** existing Tailwind/shadcn Shell  

Preserve the current product look; extend navigation and pages. This is an **internal investment ops dashboard**, not a marketing landing page.

---

## 1. Navigation (Shell)

| Label | Route | Notes |
|-------|-------|-------|
| Dashboard | `/` | Firm metrics + breach summary chips |
| Clients | `/customers` | **Primary:** SQL ledger list + detail (`CustomersExt` / `CustomerDetailExt`). `/customers-2` redirects here. `/portfolios` redirects here. |
| Clients old | `/customers-old` | Hidden from sidebar. Route kept as Postgres reference. |
| Stocks | `/stocks` | Classification columns + filters |
| Indices | `/indices` | + constituents management |
| Builder | `/builder` | **New** |
| Rebalances | `/rebalances` | **New** |
| Compliance | `/compliance` | **New** |
| Risk | `/risk` | **New** |
| Audit | `/audit` | **New** |
| Statements | `/statements` | Trading-system client statements (SQL). Unlocked. Not `/reports`. |
| Sectors | `/sectors` | Keep (non–Phase 1) |
| Sheet import | `/data-import` | Super-admin username only. QSC broker xls, not Bulk Upload. |

---

## 2. Page specs

### 2.1 Portfolio Manager `/customers-old`

**Purpose:** Air-traffic control for all discretionary portfolios, on the same page as the client list. Live primary Clients UI is `/customers` (SQL). This IPMS Postgres cockpit is kept as reference.

`/portfolios` redirects to `/customers`.

| Element | Detail |
|---------|--------|
| Filters | Shariah, risk, mandate status, breach (any/none), PM, search |
| Table columns | Client, Mandate, NAV, Cash, MTD, vs BM, Risk #, Compliance #, Pending RB, Status |
| Row click | → Client portfolio detail |
| Empty | CTA to create client/mandate |

### 2.2 Clients `/customers` + `/customers/:id`

**List:** Add columns Shariah, Risk, Mandate status, Benchmark.  
**Detail (evolve CustomerDetail):** Tabs or sections:

1. Summary (mandate strip — read-only badges + Edit Mandate)  
2. Valuation (NAV, invested, cash)  
3. Holdings (existing + weights + company name)  
4. Performance (MTD/QTD/YTD/SI vs BM)  
5. Risk & Compliance (embedded alert lists)  
6. Transactions + Cash ledger  
7. Rebalances (filtered history)  

**Mandate editor:** modal or `/customers/:id/mandate` form with validation; Approve button visible only to approver role.

### 2.3 Stocks `/stocks` + `/stocks/:id`

| Enhancement | UI |
|-------------|----|
| Columns | Group A/B/C, QERI, DSM, Illiquid badge, Regulatory |
| Filters | Group, illiquid, restricted |
| Detail | Classification panel editable by admin/pm |
| Bulk | Upload classification sheet |

### 2.4 Portfolio Builder `/builder`

**Wizard / workspace tabs:**

| Tab | Content |
|-----|---------|
| Setup | Choose Model vs Client; pick portfolio/model; show mandate constraints |
| Index Reference | Table of constituents + weights + price |
| Build | Weight editor; core/satellite helpers; auto-equal satellite |
| Review | Validation checklist + compliance results |
| Trades | Proposed BUY/SELL grid |
| Save | Save model version **or** Convert to Rebalance draft |

Print: browser print stylesheet or export button.

### 2.5 Rebalance History `/rebalances` + `/rebalances/:id`

| List | Filters: client, status, trigger, date range |
| Detail | Timeline of statuses; before/after tables; trades; compliance; approvals; documents notes |
| Actions | Approve / Execute / Finalize / Cancel / Correction (role-gated) |
| Compare | Select two IDs or before vs after toggle |

### 2.6 Compliance `/compliance`

- Open exceptions queue  
- Recent check failures  
- Request exception form  

### 2.7 Risk `/risk`

- Open alerts by severity  
- Due date highlighting  
- Assign / resolve / waive  

### 2.8 Audit `/audit`

- Filterable table  
- Expand row → old/new JSON diff  

### 2.9 Indices

- Manage constituents upload for QERI/DSM (needed by Builder Index Reference)

### 2.10 Client statements `/statements`

- Unlocked. Not the locked `/reports` AUM/IC packs.
- Investor picker (SQL `getExtClients`), statement kind, as-of or from/to.
- Preview tables from `GET /api/ext/clients/:id/statements/…` — UI does not recompute money.
- Entry from `CustomerDetailExt` with current as-of.
- Print window in Step 7 is a screen dump; trading-system PDF layout is Step 8.

### 2.11 Daily balance match `/balances`

- Unlocked. Not the locked Phase-2 `/reconciliation` stub.
- As-of date + Run compare (`snapshot.run`: admin/pm/approver/compliance). Viewer (accountant mapping) can read.
- Payload from `GET /api/snapshots` — UI does not recompute money.
- Shows QSC PortfolioValue vs IPMS MV and vs MV+cash; QSC SystemCash vs IPMS cash; QSC BankBalance with IPMS bank unknown.
- Open questions from `GET /api/balance-questions` (unsigned PV/bank/role). Does not invent a bank ledger or accountant role.

### 2.12 Live market waiting room `/live`

- Unlocked. Not Phase-3 `/markets`.
- Shows feed status from `GET /api/live/status`. Does not open a WebSocket. Does not display invented quotes.
- Historical statements stay on official close (D-016).

### 2.13 Product workshop `/workshop`

- Unlocked. Display only.
- Payload from `GET /api/product-decisions`. `signed` stays false.
- Lists BD-001…011 and handover questions 16, 18, 19, 27–31 with current implementation facts.
- Does not restore Shariah A/B/C, invent holidays, or unlock OMS.

### 2.14 Statement open questions on `/statements`

- Always visible under the preview. Payload from `GET /api/statement-questions`.
- Questions 1–8, 13–14 (footer) and 9–11 (NI/movements). Does not fill footer cells or change the NI engine.

### 2.15 Phase 1 UAT waiting room `/uat`

- Unlocked display only. `GET /api/uat/status`.
- `runnable` and `phase1Accepted` stay false. Does not tick 09-ACCEPTANCE. Later-phase routes stay locked.

---

## 3. Shared UI components to add

| Component | Use |
|-----------|-----|
| `MandateBadge` | Shariah + risk + status |
| `AlertSeverityDot` | Risk/compliance |
| `WeightBar` | Holdings / builder |
| `ComplianceResultList` | Pass/fail reasons |
| `StatusStepper` | Rebalance lock status |
| `AuditDiff` | JSON old→new |
| `RoleGate` | Hide actions by role |

---

## 4. State & API client

Extend `lib/api.ts` with typed functions matching [04-API-SPEC.md](./04-API-SPEC.md).  
Extend `AuthContext` to expose `role` and `can(action)` helpers.

---

## 5. UX rules

1. Never allow client-side-only enforcement of trading blocks — always show server error clearly.  
2. Destructive/finalize actions require confirm dialog + reason field when policy says so.  
3. Loading and empty states on every new page.  
4. Prefer additive evolution of CustomerDetail over a second conflicting portfolio page.

---

## 6. Print / PDF

Phase 1 minimum: **Print CSS** for Builder Review and Rebalance Detail. Full PDF generation can be Phase 1.1 if time allows.
