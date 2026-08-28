# Module 05 — Portfolio Builder

**Blueprint:** §7–§8 · **FR:** M5.* · **Schema:** `model_portfolios`, `model_holdings`, `builder_sessions` · **UI:** `/builder`

---

## Purpose

Workspace to construct model or client target allocations and generate proposed trades under IPS rules.

## Modes

| Mode | Target | Output |
|------|--------|--------|
| Model | `model_portfolios` | Update model holdings |
| Client | client `portfolios` | Convert to rebalance draft |

## Tabs

1. **Setup** — mode, pick entity, show mandate constraints (read-only)  
2. **Index Reference** — constituents, weights, sector, price  
3. **Build** — weight grid; helpers:  
   - Apply core from index (65%)  
   - Set satellite equal weight (35% / n, n∈[3,5])  
   - Full active editor (high)  
4. **Review** — totals, sleeve split, limits, eligibility, compliance run  
5. **Trades** — proposed BUY/SELL  
6. **Save / Convert**

## Validations (Review)

- Weights sum 100% ± tolerance  
- Medium: core 65±tol, satellite 35±tol, satellite count 3–5  
- All names eligible  
- Stock/sector soft/hard limits  
- Mandate approved (client mode)

## Print

Print stylesheet for Review tab (one-pager holdings + weights + compliance stamp).

## Test cases

1. Auto core+satellite for FS_MED produces valid review.  
2. Adding Group C to Fully Shariah fails review.  
3. Convert creates rebalance in `draft` with snapshots.
