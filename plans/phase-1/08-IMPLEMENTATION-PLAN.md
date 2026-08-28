# 08 — Implementation Plan (Single Developer)

**Replaces:** two-developer split in `QSC_Phase1.docx`  
**Owner:** M (full stack)  
**Method:** Vertical slices, shippable increments, strict Phase 1 scope

---

## 1. Principles

1. **Extend, don’t rewrite** — evolve Drizzle schema and existing pages.  
2. **Server owns rules** — eligibility, compliance, risk, mandate gates.  
3. **Audit from day one** — add `audit_logs` + helper before other modules mutate.  
4. **Demo every slice** — each milestone should be showable to QSC.  
5. **Park Phase 2+** — stubs only (execution fields, approved list).

---

## 2. Milestones

### M0 — Foundation (3–5 days)

| Task | Done when |
|------|-----------|
| Create `plans/phase-1` (this pack) accepted internally | ✓ |
| Migrate `admins` → `users` + roles | login works with role |
| Add `audit_logs` + `writeAudit()` | sample events on customer update |
| Add `ips_limit_config` seed | readable via API |
| AuthContext exposes role | RoleGate works |

### M1 — Stock Master Phase 1 (4–6 days)

| Task | Done when |
|------|-----------|
| Columns + migration on `stocks` | tags stored |
| `index_constituents` | QERI/DSM upload |
| Eligibility API | mandate→universe |
| Stocks UI filters/badges | PM can maintain |

### M2 — Mandates (5–7 days)

| Task | Done when |
|------|-----------|
| `mandates`, restrictions, status history | CRUD |
| Approve workflow | trading gate enforced on txs + builder |
| Customer UI mandate panel | create→approve demo |
| Auto benchmark + default model link | R1–R4 rules |

### M3 — Cash + Client Portfolio pack (4–6 days)

| Task | Done when |
|------|-----------|
| `cash_transactions` + balance | deposits work |
| Enhanced portfolio API §14 sections | payload complete |
| CustomerDetail redesign sections | NAV/cash/performance/risk placeholders |
| Block txs if mandate not approved | tested |

### M4 — Compliance + Risk engines (6–8 days)

| Task | Done when |
|------|-----------|
| compliance-engine + results tables | run on demand |
| exceptions workflow | approve/reject |
| risk-engine + alerts + scan job | thresholds from Blueprint |
| `/compliance` + `/risk` pages | queues usable |
| Embed flags on portfolio APIs | Portfolio Manager ready |

### M5 — Portfolio Manager cockpit (2–4 days)

| Task | Done when |
|------|-----------|
| `/portfolio-manager` API | filters server-side |
| `/portfolios` page | replaces “many Excel tabs” |

### M6 — Models + Portfolio Builder (8–12 days)

| Task | Done when |
|------|-----------|
| Seed 6 models + holdings CRUD | |
| Builder sessions API | |
| Index Reference / Build / Review / Trades UI | |
| Core-satellite helpers | medium rules validated |
| Propose trades + compliance review | |
| Convert → rebalance draft | |

### M7 — Rebalance History (5–7 days)

| Task | Done when |
|------|-----------|
| Full rebalance schema + state machine | |
| Snapshots before/after | |
| Approve / execute / finalize / cancel | |
| List/detail/compare/print | |
| Corrections on final | |

### M8 — Audit polish + hardening (3–5 days)

| Task | Done when |
|------|-----------|
| `/audit` UI | searchable |
| System health endpoint | basic |
| UAT script pass | [09-ACCEPTANCE-CRITERIA.md](./09-ACCEPTANCE-CRITERIA.md) |
| Seed demo dataset | 3 clients × different Shariah/risk |

---

## 3. Suggested calendar (indicative ~8–10 weeks solo)

| Week | Focus |
|------|-------|
| 1 | M0 + M1 start |
| 2 | M1 finish + M2 |
| 3 | M2 finish + M3 |
| 4 | M4 |
| 5 | M4 finish + M5 |
| 6–7 | M6 Builder |
| 8 | M7 Rebalance |
| 9 | M8 UAT fixes |
| 10 | Buffer / demo / docs |

Aligns roughly with PSA 10-week envelope for **Phase 1 depth**, not the entire Annex A module list (full IPMS still continues in Phases 2–4).

---

## 4. Obsolete two-dev split → solo mapping

| Old idea (from meeting brief) | Solo approach |
|-------------------------------|---------------|
| Dev A backend / Dev B frontend | Same person ships vertical slices |
| Parallel module ownership | Strict sequence M0→M8 to reduce rework |
| Separate “integration week” | Integrate continuously each milestone |

---

## 5. Risk register (delivery)

| Risk | Mitigation |
|------|------------|
| Scope creep into OMS/reports | Written out-of-scope list; stub only |
| Constituent weight data unavailable | Manual CSV upload; document Client dependency |
| Solo bottleneck | Milestone demos; keep modules shippable independently |
| Schema churn | Follow DATABASE-SCHEMA; migrate incrementally |
| Float money bugs | `numeric` + string decimals in JSON |

---

## 6. Definition of ready for each milestone

- Schema migration written  
- API routes + authz  
- UI path from nav  
- Audit events  
- Demo script (5 minutes)  
- Notes of Phase 2 leftovers  

---

## 7. Tools / commands (repo)

```bash
# backend
npm run db:generate   # or project’s drizzle kit script
npm run db:migrate
npm run seed
npm run dev

# frontend
npm run dev --workspace=artifacts/portfolio-dashboard
```

(Adjust to actual package.json script names when executing.)
