# Module 06 — Rebalance History

**Blueprint:** §8.1 · **FR:** M6.* · **Schema:** `rebalances`, `rebalance_proposed_trades`, `rebalance_corrections` · **UI:** `/rebalances`

---

## Purpose

Locked evidence of every rebalance: why, what changed, who approved, compliance outcome.

## Mandatory fields

Rebalance ID/code · Client/Model · Timestamps · Trigger · Before snapshot · Target · Proposed trades · Compliance · Approval trail · Execution stubs · Allocation method stub · After snapshot · Documents/notes · Lock status

## Triggers

`quarterly_review` · `benchmark_change` · `active_review` · `breach` · `cash_deposit` · `cash_withdrawal` · `ad_hoc`

## Lock status

`draft` → `approved` → `executed` → `final` / `cancelled`

Final immutable except `rebalance_corrections`.

## Snapshots (jsonb)

```json
{
  "asOf": "2026-08-04",
  "nav": "1000000",
  "cash": "50000",
  "holdings": [{"ticker":"QNBK","qty":"100","weight":0.12,"mv":"..."}],
  "sectors": [{"sector":"Banks","weight":0.40}],
  "metrics": {"topWeight":0.12}
}
```

## UI

List/filter · Detail timeline · Compare before/after · Print · Role-gated actions

## Test cases

1. Final rejects PATCH body.  
2. Correction creates audit + correction row.  
3. Filter by trigger=breach returns expected.
