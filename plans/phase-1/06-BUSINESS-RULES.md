# 06 — Business Rules (IPS Engine)

All rules below must be enforced **server-side**. UI validation is convenience only.

---

## 1. Mandate → universe → construction

| Shariah preference | Eligible groups | Benchmark | Medium construction | High construction |
|--------------------|-----------------|-----------|---------------------|-------------------|
| Fully Shariah | A | QERI | FS_MED 65/35 | FS_HIGH full active |
| Shariah + Purifying | A + B | QERI | SP_MED 65/35 | SP_HIGH full active |
| Unrestricted | A + B + C | DSM | UN_MED 65/35 | UN_HIGH full active |

### Rules

- R1: Changing Shariah preference or risk profile **requires** remapping model + re-approval if previously Approved (status → Amended or Pending per policy; recommend **Amended** with re-approve).  
- R2: Trading / proposing rebalance **blocked** unless `approval_status = approved`.  
- R3: Closed mandates: read-only; no new rebalances.  
- R4: Client restrictions always apply on top of group eligibility.

---

## 2. Stock eligibility

```
eligible(mandate, stock) =
  stock.is_tradable
  AND stock.regulatory_status NOT IN (restricted, suspended)  -- block NEW exposure
  AND stock.shariah_group IN mandate.allowed_groups
  AND NOT matches_active_restriction(mandate, stock)
```

| Case | Behavior |
|------|----------|
| Ineligible on BUY proposal | Fail compliance `SHARIAH_UNIVERSE` or `RESTRICTION` or `REGULATORY` |
| Illiquid (`ADTV < 100000` or flag) | Warning; configurable hard-block later — Phase 1: **warning + reason**, prevent if compliance config `liquidity_hard_block=true` (default false) |
| Existing holding becomes ineligible | Risk/compliance monitoring alert; do not auto-sell in Phase 1 |

---

## 3. Core-satellite construction (Medium)

| Sleeve | Weight | Method |
|--------|--------|--------|
| Core | 65% of portfolio | Benchmark constituent weights, renormalized to stocks in eligible universe that are index members |
| Satellite | 35% of portfolio | 3 to 5 stocks, **equal weight** within satellite (each ≈ 35%/n) |

### Validation

- Sum of all target weights = 100% (±0.01% tolerance)  
- Satellite count ∈ [3, 5] for medium  
- Every name eligible for mandate  
- Stock weight ≤ soft/hard IPS limits (see §5)  
- Sector weights ≤ limits  

### High (full active)

- No required core sleeve  
- 100% active selection  
- Same stock/sector IPS limits  
- No fixed 3–5 count (recommend reasonable max, e.g. 20, as soft warning)

---

## 4. Proposed trades

Given current holdings+cash and target weights + NAV:

1. Compute target MV per stock = weight × NAV  
2. Diff vs current MV → BUY/SELL values  
3. Convert to shares using latest price (floor/round policy: document as round to 0 decimals for QSE equities unless fractional allowed)  
4. Ensure cash sufficient for net buys + buffer (compliance `CASH_CHECK`)  
5. Do not propose BUY on regulatory-blocked names  

Phase 1 does **not** require broker routing; applying trades writes `transactions` + updates cash when lock moves to `executed`/`final` (product choice: allow PM to mark executed manually).

---

## 5. IPS concentration & loss limits (Risk + Compliance)

| Rule key | Threshold | Compliance action | Risk action |
|----------|-----------|-------------------|-------------|
| stock_soft | 15% | Prevent additional BUY unless index exception | Alert `stock_weight_15` |
| stock_hard | 20% | Fail | Critical; due reduce to 15% in **10 trading days** |
| sector_soft | 35% | Prevent additional BUY in sector | Alert `sector_weight_35` |
| sector_hard | 40% | Fail | Critical; reduce to 35% in **5 trading days** |
| loss_15 | −15% vs cost or peak (define: vs cost for Phase 1) | — | Review thesis in 5 business days |
| loss_25 | −25% | — | Exit plan in 5 business days |
| loss_30 | −30% | — | Approval within 1 business day to continue |
| underperform_3m | portfolio − benchmark < −5% rolling 3M | — | Attribution due in 2 weeks |
| excess_cash | cash/NAV > policy (seed 10% default, configurable) | Warning | Deployment review alert |

**Index exception:** If single stock weight exceeds 15% **because** it is overweight in the benchmark core, allow with explicit exception flag + audit (document in compliance exception).

---

## 6. Compliance check catalog

| Code | Timing (Phase 1) | Fail when |
|------|------------------|-----------|
| MANDATE_STATUS | before_proposal | status ≠ approved |
| MANDATE_CLASSIFICATION | before_proposal | missing/invalid fields |
| SHARIAH_UNIVERSE | before_proposal | any target/BUY not in allowed groups |
| RESTRICTION | before_proposal | violates client restriction |
| APPROVED_LIST | before_proposal | stub: skip or warn if no research status (Phase 3) |
| STOCK_LIMIT | before_proposal / after apply | weight > hard; soft blocks incremental buy |
| SECTOR_LIMIT | before_proposal / after apply | same |
| CASH_CHECK | before_proposal | insufficient cash for net buys |
| REGULATORY | before_proposal | new exposure to restricted/suspended |
| EXCEPTION_REQUIRED | before_proposal | override without approved exception |

Every run stores rows in `compliance_results`.

---

## 7. Rebalance state machine

```
draft → approved → executed → final
  ↓        ↓
cancelled  cancelled
```

| Transition | Who | Requirements |
|------------|-----|--------------|
| → draft | PM | mandate approved; snapshots target+before |
| draft → approved | Approver (or compliance role) | compliance all pass or approved exceptions |
| approved → executed | PM | optional: apply txs; fill execution stubs |
| executed → final | Approver/PM policy | after_snapshot written; lock |
| * → cancelled | Approver | reason required |
| final → * | **forbidden** | use `rebalance_corrections` only |

---

## 8. Audit mandatory events

Create audit_log on:

- Mandate create/update/status change  
- Stock master tag changes  
- Model holding changes  
- Builder convert → rebalance  
- Rebalance status transitions  
- Compliance exception request/approve  
- Risk alert resolve/waive  
- User create/role change  
- Cash deposit/withdrawal  
- Transaction create when linked to rebalance  

---

## 9. Fee / ops forms (awareness only)

F-01–F-06 do **not** drive Phase 1 UI. Ensure Phase 1 data can later support:

- NAV at month-end (valuation from prices + cash)  
- **Management fee (D-008):** day-weighted average daily NAV within the calendar month × annual% / 12 — mid-month funding / `CLIENT_TRANSFER` must not backdate the new NAV to day 1  
- **Performance fee:** crystallisation excess over HWM only; no charge if NAV ≤ HWM; in-kind transfer raises HWM by transfer value  
- Mandate/contract dates on customer/mandate  
- Approval audit for fee sign-off (Phase 2)

See [13-OPS-FORMS-MAPPING.md](./13-OPS-FORMS-MAPPING.md).

---

## 10. Broker blotter reconstruction (historical import)

Applies to QSC sheet import (`PMProfitLossTransaction` / `FMClientAccountSummary`) only. Live UI trades keep listed price × qty (HP-CONF-06).

- **Booking unit price** = Buy Value ÷ qty (buys / transfer-in) or Sell Value ÷ qty (sells). Fallback = listed Price when Value is missing or ≤ 0. Replay engine stays qty × stored price, so Gross and trade cash match the file after re-import.
- **Buy/Sell cash rows** in the account-summary sheet are skipped; trade cash is rebuilt from the booking unit price. Do not post those ledger rows as well.
- **Column names (file wins over the 11 June meeting notes):** `Daily Result` = per-trade realized P/L (Sell Value − cost of sold shares). `Profit/Loss` = cumulative realized. Holdings table shows **unrealized** (MV − WAC). Cumulative realized stays on the Performance tab until a product decision puts it on Holdings.

