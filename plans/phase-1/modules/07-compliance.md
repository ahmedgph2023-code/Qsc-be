# Module 07 — Compliance

**Blueprint:** §13 · **FR:** M7.* · **Schema:** check defs, `compliance_results`, `compliance_exceptions` · **UI:** `/compliance`

---

## Purpose

Permission layer: may this proposal/trade proceed? Distinct from Risk (danger vs permission).

## Phase 1 timings

Primarily `before_proposal` (Builder review + rebalance approve). Optionally re-run `after_trade` when execute applies txs.

## Checks

Mandate status/classification · Shariah universe · Restrictions · Stock/sector limits · Cash · Regulatory · Exception present when overriding

Approved List / five-layer: **stub warning** only (Phase 3).

## Exception workflow

Request (reason, check_code, validity) → Approve/Reject → Use on rebalance → Expire

## Dashboard

Open exceptions · Recent fails · Link to portfolio/rebalance

## Test cases

1. Hard sector 41% → fail `SECTOR_LIMIT`.  
2. Approved exception allows approve rebalance.  
3. Expired exception does not.
