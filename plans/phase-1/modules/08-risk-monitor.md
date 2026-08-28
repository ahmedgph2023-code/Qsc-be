# Module 08 — Risk Monitor

**Blueprint:** §12 · **FR:** M8.* · **Schema:** `risk_alerts`, `ips_limit_config` · **UI:** `/risk` + embeds

---

## Purpose

Live IPS breach detection with owners and due dates.

## Alert catalog

| Type | Condition | Due |
|------|-----------|-----|
| stock_weight_15 | weight > 15% | notify; block buys via compliance |
| stock_weight_20 | weight > 20% | 10 trading days to ≤15% |
| sector_weight_35 | sector > 35% | prevent buys |
| sector_weight_40 | sector > 40% | 5 days to ≤35% |
| stock_loss_15/25/30 | vs cost | 5bd / 5bd / 1bd approval |
| underperform_3m | vs BM < −5% | 2 weeks attribution task |
| excess_cash | cash/NAV > policy | review |
| liquidity / regulatory | holding flags | monitor |

## Engine

`risk-engine.scanPortfolio(id)` and `scanAll()` — upsert open alerts; auto-resolve when condition clears (with audit).

## Trading days

Use simple calendar first (skip Fri–Sat for Qatar week) or business-day table; document approximation.

## Test cases

1. Force weight 21% → critical alert + due_date.  
2. Reduce below 15% → alert resolves on rescan.  
3. Waive requires approver + reason.
