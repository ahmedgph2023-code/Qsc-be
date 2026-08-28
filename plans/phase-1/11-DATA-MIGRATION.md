# 11 — Data Migration Plan

---

## Goals

- Preserve all existing customers, portfolios, transactions, stocks, prices, corporate actions, indices, sector intel.  
- Add Phase 1 columns/tables without downtime-destructive drops.  
- Backfill safely with explicit defaults and admin review lists.

---

## Migration sequence

### Step 1 — Users

1. Create `users` table.  
2. Copy `admins` → `users` with `role='admin'`.  
3. Point auth to `users`.  
4. Keep `admins` read-only one release, then drop.

### Step 2 — Audit + IPS config

1. Create `audit_logs`, `ips_limit_config`, compliance check seed tables.  
2. No backfill required.

### Step 3 — Stock classification

1. Add nullable classification columns to `stocks`.  
2. Provide bulk upload template for QSC to fill Group A/B/C, membership, ADTV.  
3. Until backfilled: eligibility treats `shariah_group IS NULL` as **fail closed** for proposals (or warn-only flag `STRICT_UNIVERSE=false` for dev).  
4. **Production recommendation:** fail closed once QSC provides file.  
5. Create `index_constituents`; upload QERI/DSM weights.

### Step 4 — Mandates

1. Create `mandates` + restrictions + history.  
2. For each existing customer, create mandate row:  
   - `approval_status='pending'`  
   - temporary defaults only in DEV seed; **PROD requires PM to set real values before approve**  
3. Do not auto-approve.

### Step 5 — Portfolio extensions + cash

1. Add portfolio columns (`model_portfolio_id`, `cash_balance`, …).  
2. Create `cash_transactions`.  
3. Initial cash: `0` unless QSC provides opening cash balances file.  
4. Optional: opening balance import tool.

### Step 6 — Models

1. Seed six `model_portfolios`.  
2. Holdings empty until Builder used.  
3. Link mandate→model on approve via rules.

### Step 7 — Builder / rebalance / compliance / risk

Create empty tables; no historical backfill (rebalance history starts at go-live of module).

---

## Data QSC must provide

| Dataset | Required for | Format |
|---------|--------------|--------|
| Stock Shariah groups A/B/C | Eligibility | Excel/CSV by ticker |
| QERI & DSM constituent weights | Builder core | Excel/CSV |
| ADTV or illiquid list | Liquidity flag | Excel/CSV |
| Regulatory restricted list | Blocks | Excel/CSV |
| Opening cash per portfolio | NAV accuracy | Excel/CSV |
| Mandate fields per client | Trading | Form or sheet |
| User list + roles | RBAC | Sheet |

---

## Rollback

- Each Drizzle migration reversible where possible (`DROP` new tables; drop new columns).  
- Never migrate by deleting transaction history.  
- Backup Postgres before production migration (`pg_dump`).

---

## Validation queries (post-migrate)

```sql
-- orphans
SELECT c.id FROM customers c LEFT JOIN portfolios p ON p.customer_id = c.id WHERE p.id IS NULL;
-- unclassified stocks
SELECT ticker FROM stocks WHERE shariah_group IS NULL;
-- mandates pending
SELECT count(*) FROM mandates WHERE approval_status = 'pending';
```
