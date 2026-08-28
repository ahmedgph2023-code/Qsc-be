# Module 02 — Stock Master

**Blueprint:** §6 · **FR:** M2.* · **Schema:** extend `stocks`, `index_constituents` · **UI:** Stocks list/detail

---

## Purpose

One master list of QSE names with tags that drive eligibility and Builder index reference.

## Classification

| Tag | Values / rule |
|-----|----------------|
| Shariah group | A Pure / B Purifying / C Conventional |
| Sector | string (existing) |
| QERI member | boolean (+ weight in constituents) |
| DSM member | boolean (+ weight) |
| ADTV | QAR; illiquid if < 100,000 |
| Regulatory | clear / watch / restricted / suspended |
| Tradable | boolean |

## Eligibility matrix

| Group | Fully Shariah | Shariah+Purifying | Unrestricted |
|-------|---------------|-------------------|--------------|
| A | ✓ | ✓ | ✓ |
| B | ✗ | ✓ | ✓ |
| C | ✗ | ✗ | ✓ |

## Admin operations

- Manual edit on stock detail  
- Bulk classification upload (ticker + columns)  
- Constituents upload per index + effective date  

## Services

`eligibility.isStockAllowed(mandate, stock) → { allowed, reasons[] }`

## Test cases

1. Group C stock denied for Fully Shariah.  
2. Restricted stock denied for new BUY even if Unrestricted.  
3. Illiquid warning on review.  
4. Constituent weights sum ~1 for index snapshot date.
