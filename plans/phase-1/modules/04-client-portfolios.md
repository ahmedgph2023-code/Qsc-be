# Module 04 — Client Portfolios

**Blueprint:** §14 · **FR:** M4.* · **UI:** enhance `CustomerDetail` · **API:** enhance `GET /portfolios/:id`

---

## Purpose

Single-client master screen: valuation, holdings, performance, risk, mandate, actions.

## Sections

| Section | Content |
|---------|---------|
| Summary | Name, account, mandate, BM, model, Shariah, risk, approval |
| Valuation | NAV, invested MV, cash, accrued dividends (basic), unsettled stub |
| Performance | MTD, QTD, YTD, SI vs benchmark |
| Risk | Concentration top weights, sector pie/table, open alerts |
| Holdings | Ticker, shares, MV, weight, cost, unrealized P&L |
| Actions | Pending rebalance, breaches, approvals |
| Cash | Ledger + add deposit/withdrawal |
| Transactions | Existing list/upload gated by mandate |

## NAV (Phase 1)

```
NAV = market_value_holdings + cash_balance
```

Liabilities/fees deferred unless cash `fee` type posted.

## Test cases

1. Deposit 10k increases cash and NAV.  
2. Mandate strip matches mandates table.  
3. Weight column sums ~100% invested sleeve (cash separate).
