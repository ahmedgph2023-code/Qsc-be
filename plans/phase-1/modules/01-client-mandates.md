# Module 01 — Client Mandates

**Blueprint:** §5 · **FR:** M1.* · **Schema:** `mandates`, `mandate_restrictions`, `mandate_status_history` · **UI:** Customers + mandate editor

---

## Purpose

Encode the client’s IPS contract profile so the system knows universe, benchmark, construction style, and whether trading is allowed.

## Fields

| Field | Values | Impact |
|-------|--------|--------|
| Mandate type | discretionary | IPS scope only |
| Shariah preference | fully_shariah / shariah_purifying / unrestricted | Groups A / A+B / A+B+C |
| Risk profile | medium / high | core-satellite vs full active |
| Benchmark | QERI or DSM (auto) | Performance + core weights |
| Restrictions | stock/sector/other | Pre-trade blocks |
| Approval status | pending / approved / amended / closed | Gate |

## Screens

1. **Mandate form** — all fields required; show derived benchmark + model code preview.  
2. **Restrictions list** — add/remove.  
3. **Status actions** — Submit / Approve / Amend / Close with reason.  
4. **History** — status timeline.

## API

See API-SPEC §2. Enforce: only Approver (or admin) can approve/close.

## Business rules

See BUSINESS-RULES §1. On approve: link default `model_portfolios` by (shariah, risk); set `benchmark_index_id`.

## Audit

Log every create/update/status change with old→new JSON.

## Test cases

1. Fully Shariah + Medium → QERI + FS_MED.  
2. Unrestricted + High → DSM + UN_HIGH.  
3. Pending client: POST BUY → 403 `MANDATE_NOT_APPROVED`.  
4. Restriction on QNBK blocks that ticker in compliance.
