# Module 09 — Audit Trail

**Blueprint:** §17 · **FR:** M9.* · **Schema:** `audit_logs` · **UI:** `/audit`

---

## Purpose

Immutable evidence of who changed what — regulatory and IC trust layer.

## Record shape

| Field | Description |
|-------|-------------|
| occurred_at | timestamp |
| user_id | actor |
| action | create/update/approve/... |
| object_type / object_id | target |
| old_value / new_value | jsonb |
| reason | free text when required |
| ip / request_id | optional |

## Covered objects (Phase 1)

users · customers · mandates · stocks (classification) · model_holdings · builder_sessions (convert) · rebalances · compliance_exceptions · risk_alerts · cash_transactions · transactions (when gated/rebalance-linked)

## UI

Filters: date range, user, object type, action · Expandable diff · Export CSV (Should)

## Hard rules

- Application **cannot** UPDATE/DELETE audit rows  
- Failed auth attempts may be logged (Should)  
- System health widget: DB ok, last price date  

## AI banner

Display: “AI features are analysis-only and cannot trade, approve, or override compliance.”

## Test cases

1. Approve mandate → audit row with status transition.  
2. DELETE `/audit/:id` → 404/405.  
3. Filter by object_id returns mandate history only.
