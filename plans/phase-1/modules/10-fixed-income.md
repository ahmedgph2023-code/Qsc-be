# 10 — Fixed Income

## Scope
QSE-listed debt: `GA` gov bonds, `TE` T-bills, `SA` sukuk, `TA`/`TB`/`TC`/`CA`/`KA` other debt.  
Rights `R0` remain excluded.

## Dual valuation
- **Book:** coupon accrual + premium/discount amortization  
- **MTM:** dirty market value change from `% of par` prices in `stock_prices`

## Semi-annual daily profit (ACT_PERIOD)

For each coupon window (exactly 6 calendar months, or stub to maturity):

1. Count **actual calendar days** in `[periodStart, periodEnd)` — months with 28/29/30/31 days are included automatically (typical windows are 181–184 days).
2. Period coupon per 100 par = `couponRate × 100 / 2`.
3. **Daily accrual per 100** = `periodCoupon / actualDays`.
4. Lot daily coupon = `dailyAccrualPerPar × (faceAmount / facePar)`.

Verified identity: sum of daily accruals over the period equals the period coupon exactly.

Rows are persisted in `fi_daily_pnl` from purchase/settlement date through maturity (or sell date).

## How to operate
1. Open **Fixed Income** → Edit terms (issue, maturity, coupon %, frequency).  
2. Save rebuilds coupon schedule (shows actual days + daily accrual).  
3. BUY a FI ticker on a client portfolio → lot auto-created + daily series generated.  
4. Open lot daily P&L chart/table under `/fixed-income/lots/:portfolioId/:lotId`.  
5. Rebuild: `POST /api/fi/lots/:id/rebuild-daily-pnl`.

## API
See `/api/fi/*` routes in `src/routes/fixed-income.ts`.
