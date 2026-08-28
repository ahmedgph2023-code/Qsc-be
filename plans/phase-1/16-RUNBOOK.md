# Phase 1 — Run locally after this implementation

## 1. Apply database schema

Postgres is expected on `localhost:5433` with `DATABASE_URL` in `qse-back/.env` (host port `5433` avoids conflicts with other local Postgres instances on `5432`).

```powershell
cd D:\Github\qse-back
npx drizzle-kit push
npm run db:seed
npm run db:seed:historical
```

`db:seed:historical` loads QSC historical-data: stocks (Shariah group A), QERI/DSM index series, prices, client 37808, trades, and cash.

Migration SQL (if you prefer manual apply): `drizzle/0001_phase1_core.sql`

## 2. Start servers

```powershell
# backend
cd D:\Github\qse-back
npm run dev

# frontend (sets PORT=5173 and BASE_PATH=/)
cd D:\Github\qse-front
npm run dev
```

## 3. Demo logins (after seed)

| User | Password | Role |
|------|----------|------|
| admin | admin | admin |
| pm | pm | pm |
| approver | approver | approver |
| compliance | compliance | compliance |

## 4. Smoke path

1. Login as `admin`
2. Stocks → set Shariah group A/B/C on names
3. Clients → open client → Mandate & Control → save Fully Shariah / Medium → Approve (as approver)
4. Portfolio Manager → see row flags
5. Builder → client session → weights → Review → Convert
6. Rebalances → Approve → Execute → Finalize
7. Risk → Scan all · Compliance · Audit
8. **Balances** (`/balances`) → pick as-of after 15:00 Qatar → Run compare (SQL snapshot vs IPMS). Set `SNAPSHOT_CRON_ENABLED=true` for 15:15 Asia/Qatar weekdays.

## 5. Fixed income

1. Markets → **Fixed Income**
2. Edit terms: issue date, maturity, coupon %, frequency (`semi_annual` default)
3. Save — schedule shows **actual days** per 6-month window and **daily accrual = coupon ÷ days**
4. On a client portfolio, BUY the FI ticker (price = % of par, quantity = units)
5. Lot daily P&L is saved automatically; open `/fixed-income/lots/:portfolioId/:lotId`
6. Rebuild: `POST /api/fi/lots/:id/rebuild-daily-pnl`

See [modules/10-fixed-income.md](./modules/10-fixed-income.md).
