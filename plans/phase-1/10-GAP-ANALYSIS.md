# 10 — Gap Analysis (Current Code → Phase 1)

**Repos:** `qse-back` + `qse-front/artifacts/portfolio-dashboard` as of planning date.

---

## Summary scorecard

| Phase 1 module | % ready | Verdict |
|----------------|---------|---------|
| Client Mandates | 5% | Greenfield on top of thin customers |
| Stock Master | 40% | Prices/CRUD exist; classification missing |
| Portfolio Manager | 25% | Firm dashboard only |
| Client Portfolios | 50% | Holdings/TWAR/benchmark; no cash/mandate/risk panels |
| Portfolio Builder | 0% | Missing |
| Rebalance History | 0% | Missing |
| Compliance | 0% | Missing |
| Risk Monitor | 0% | Missing |
| Audit Trail | 0% | Missing |

**Extra (not Phase 1):** Sector AI ~70% useful for later Phase 3 · Corporate actions ~60% toward Phase 2.

---

## Backend gaps

| Area | Exists | Missing |
|------|--------|---------|
| Schema | admins, indices, stocks, prices, CA, adj prices, customers, portfolios 1:1, transactions, sector intel | users/roles, mandates, constituents, cash, models, builder, rebalances, compliance, risk, audit |
| Auth | JWT single admin | RBAC, approval roles |
| Services | calculations (holdings, TWAR, AUM), uploads, gemini/sectors | eligibility, compliance-engine, risk-engine, snapshots, proposed-trades, audit writer |
| Routes | auth, customers, portfolios, txs, stocks, indices, dashboard, sectors | mandates, portfolio-manager, builder, rebalances, compliance, risk, audit, users |

---

## Frontend gaps

| Area | Exists | Missing |
|------|--------|---------|
| Nav | Dashboard, Customers, Stocks, Sectors, Indices | Portfolios cockpit, Builder, Rebalances, Compliance, Risk, Audit |
| Pages | Login, Dashboard, Customers, CustomerDetail, Stocks, StockDetail, Sectors, Indices | Mandate editor, classification UX, builder wizard, rebalance detail, queues |
| Auth UI | login + token | role-gated actions |
| api.ts | current resources | all Phase 1 endpoints |

---

## Reuse map (do not throw away)

| Asset | Reuse plan |
|-------|------------|
| `calculations.ts` | Extend for NAV with cash, weights, sector aggregation, MTD/QTD/YTD packs |
| `CustomerDetail.tsx` | Become Client Portfolio master screen |
| `Stocks.tsx` / bulk upload | Add classification columns + bulk tag upload |
| `Dashboard.tsx` | Keep firm AUM; link into Portfolio Manager |
| `indices` | Become QERI/DSM homes + constituents |
| Transactions | Holdings source; gate with mandate + compliance |
| Drizzle + Postgres + Docker | Keep |

---

## Breaking changes to plan carefully

1. **`admins` → `users`:** migrate seed credentials; update JWT payload (`userId`, `role`).  
2. **Portfolio payload shape:** additive fields first; frontend tolerates missing.  
3. **`portfolios.customer_id` unique:** keep for Phase 1 (1:1).  
4. **Sector string on stocks vs sectors table:** keep free-text sector for IPS limits; optionally normalize later.

---

## Recommended first code PR (after plans sign-off)

1. Schema: users + audit_logs + ips_limit_config  
2. Middleware: role helpers  
3. Audit on one existing route (customers update) as pattern  
4. No UI redesign yet  

Then Stock Master columns PR, then Mandates PR, etc. per [08-IMPLEMENTATION-PLAN.md](./08-IMPLEMENTATION-PLAN.md).
