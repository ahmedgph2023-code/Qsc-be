# Module 03 — Portfolio Manager

**Blueprint:** §4 Portfolio Manager · **FR:** M3.* · **API:** `GET /portfolio-manager` · **UI:** `/portfolios`

---

## Purpose

Multi-portfolio cockpit — which books are healthy, which need action.

## Row metrics

- Identity: client name, account, PM  
- Mandate badges: Shariah, risk, status  
- Valuation: NAV, cash %  
- Performance: MTD (min), optional YTD  
- Control: open risk count, open compliance exceptions, pending rebalance flag  

## Filters

Shariah · Risk · Mandate status · Has breaches · Has pending rebalance · Text search · PM

## Interactions

- Click row → Client Portfolio  
- Quick links: open Risk filtered to portfolio; open Builder for portfolio  

## Implementation notes

- Server-side aggregation; avoid N+1 by SQL joins / batched alert counts.  
- Reuse calculation services for NAV.  
- Poll or invalidate queries on focus.

## Test cases

1. Three clients appear with correct NAV.  
2. Filter “has breaches” shows only alerted.  
3. Pending rebalance flag true when draft/approved exists.
