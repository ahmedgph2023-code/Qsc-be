# 04 — API Specification (Phase 1)

**Base:** `http://localhost:5001/api`  
**Auth:** `Authorization: Bearer <jwt>` on all routes except login/health  
**Style:** Keep existing Express routers; add new route modules.

Convention: JSON bodies; UUIDs; ISO dates; amounts as strings or numbers consistently (prefer strings for `numeric` fields to avoid float issues).

---

## 1. Auth & users

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| POST | `/auth/login` | public | → `{ token, user }` |
| GET | `/auth/me` | any | current user + role |
| GET | `/users` | admin | list |
| POST | `/users` | admin | create |
| PATCH | `/users/:id` | admin | role/status |

---

## 2. Clients & mandates

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/customers` | pm+ | list + mandate summary fields |
| POST | `/customers` | pm+ | create customer (+ empty portfolio as today) |
| GET | `/customers/:id` | pm+ | detail (`?identity=1` skips holdings/metrics; `?asOf=` still attaches summary) |
| PUT | `/customers/:id` | pm+ | update demographics |
| GET | `/customers/:id/mandate` | pm+ | get mandate |
| PUT | `/customers/:id/mandate` | pm+ | create/update mandate fields |
| POST | `/customers/:id/mandate/submit` | pm | pending |
| POST | `/customers/:id/mandate/approve` | approver | → approved |
| POST | `/customers/:id/mandate/amend` | pm | → amended |
| POST | `/customers/:id/mandate/close` | approver | → closed |
| GET/POST/DELETE | `/customers/:id/mandate/restrictions` | pm+ | CRUD restrictions |

### External SQL clients (primary Clients UI — read only)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/ext/clients` | any authenticated | list accounts from `ShareTransactions`/`CashTransactions` joined to `Investors` for `name`/`nameEn`/`nameAr` (`?asOf=`) |
| GET | `/ext/clients/:id` | any authenticated | reconstructed portfolio + KPIs (`:id` = `ClientId` / `ObjCode`) |
| GET | `/ext/clients/:id/shares` | any authenticated | share blotter through as-of (`?page=&pageSize=&q=&side=&invType=` — SQL `OFFSET/FETCH`) |
| GET | `/ext/clients/:id/cash` | any authenticated | cash blotter page + running `balanceAfter` (`?page=&pageSize=&q=&status=&from=`) |
| GET | `/ext/clients/:id/statements/portfolio` | any authenticated | trading-system portfolio statement JSON (`?asOf=` YYYY-MM-DD; official close only) |
| GET | `/ext/clients/:id/statements/account` | any authenticated | account statement JSON (`?from=` `&to=` required) |
| GET | `/ext/clients/:id/statements/realized-summary` | any authenticated | realized P&L summary JSON (`?from=` `&to=` required; dividend/footer unknowns stay null) |
| GET | `/ext/clients/:id/statements/realized-details` | any authenticated | realized P&L blotter JSON (`?from=` `&to=` required) |
| GET | `/ext/clients/:id/statements/portfolio.xlsx` | any authenticated | One-sheet workbook (identity + holdings + recap). Unsigned footer cells stay blank. |
| GET | `/ext/clients/:id/statements/account.xlsx` | any authenticated | account statement workbook (`?from=` `&to=` required) |
| GET | `/ext/clients/:id/statements/realized-summary.xlsx` | any authenticated | realized P&L summary workbook |
| GET | `/ext/clients/:id/statements/realized-details.xlsx` | any authenticated | realized P&L blotter workbook |
| GET | `/ext/clients/sync-status` | any authenticated | `SyncWatermark` |
| GET | `/snapshots` | any authenticated | stored Cloudilic vs QSC compare for `?asOf=` (default today Qatar). Additive `qscDates` (SQL dates + row counts + `lastUpdated`, read-only) and `storedDates` (Postgres). Status: `matched` \| `cash_only` \| `mismatch` \| `incomplete` \| `qsc_missing`. `cash_only` = no equity (IPMS MV = 0) with cash still matching — not a PortfolioValue sign-off. |
| POST | `/snapshots/run` | pm / approver / compliance / admin | recompute IPMS snapshot from SQL blotter + official closes; upsert `ipms_client_snapshots`. Does not write SQL. |
| GET | `/live/status` | any authenticated | Phase 7 broadcast status. Never returns a live book. `connected` stays false until URL + JSON samples. Does not write `stock_prices`. |
| GET | `/product-decisions` | any authenticated | Phase 8 open BD list. `signed` is always false. Display only; no POST. Does not change engines. |
| GET | `/statement-questions` | any authenticated | Phase 2+3 open questions (1–8, 9–11, 13–14). `fillFooter` and `changeNiEngine` stay false. |
| GET | `/uat/status` | any authenticated | Phase 9 waiting room. `runnable` and `phase1Accepted` stay false. Does not run 09-ACCEPTANCE. |
| GET | `/balance-questions` | any authenticated | Phase 6 open questions (PV definition, bank, role, closes). `signed` / `inventBankLedger` / `addAccountantRole` stay false. |

No POST/PUT/DELETE on `/ext/*`. Staging tables are not exposed. Do not extend Phase 2 `report_kind`. Daily balance compare is `/api/snapshots`, not locked `/api/reconciliation`.

---

## 3. Stock master

Extend existing `/stocks`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/stocks` | + filters: `shariahGroup`, `illiquid`, `regulatoryStatus`, `qeri`, `dsm` |
| GET | `/stocks/:id` | include Phase 1 tags |
| POST/PUT | `/stocks`, `/stocks/:id` | include tags |
| PATCH | `/stocks/:id/classification` | admin/pm: shariah, regulatory, ADTV |
| POST | `/stocks/bulk-classification` | Excel/CSV tag update |
| GET | `/stocks/eligibility` | query: `mandateId` or mandate fields → eligible universe |
| GET | `/indices/:id/constituents` | list weights |
| PUT | `/indices/:id/constituents` | replace/upload constituents for date |

---

## 4. Portfolios, cash, manager

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/portfolio-manager` | multi-portfolio cockpit rows + flags |
| GET | `/portfolios/:id` | **enhanced** client portfolio payload |
| GET | `/portfolios/:id/holdings` | existing |
| GET | `/portfolios/:id/cash` | balance + ledger |
| POST | `/portfolios/:id/cash` | deposit/withdrawal |
| PUT | `/portfolios/:id/model` | link model portfolio |
| GET | `/dashboard/metrics` | keep; add breach counts |

### Portfolio Manager row shape (response)

```json
{
  "portfolioId": "...",
  "customerName": "...",
  "nav": "1000000.00",
  "cash": "50000.00",
  "mtdReturn": 0.012,
  "shariahPreference": "fully_shariah",
  "riskProfile": "medium",
  "mandateStatus": "approved",
  "openRiskAlerts": 2,
  "openComplianceExceptions": 0,
  "pendingRebalance": true
}
```

### Client portfolio enhanced sections

`summary`, `valuation`, `excelWorkbook` (HP-W5 labeled equity growth/gain; `indexPerformancePct` from mandate benchmark first-activity to as-of, D-011; not GOV-02), `dailyChanges` (NAV incl. cash, last 120 closes), `allocation` (cash + sector weights vs NAV; HP-W4), `performance` (series rebased to first activity, not first-ever index print), `risk`, `holdings` (additive `openedOn`, `holdingDays`, `excelAnnualizedPct`, `excelContributionPct`, `excelWeight`), `actions` — mirror Blueprint §14.

---

## 5. Models & builder

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/models` | list six + custom |
| GET | `/models/:id` | + holdings |
| PUT | `/models/:id/holdings` | replace targets (compliance-checked) |
| POST | `/builder/sessions` | start session (model or client) |
| GET | `/builder/sessions/:id` | load |
| PATCH | `/builder/sessions/:id` | save payload |
| POST | `/builder/sessions/:id/review` | run validations + compliance |
| POST | `/builder/sessions/:id/propose-trades` | current→target trades |
| POST | `/builder/sessions/:id/convert` | create rebalance draft |
| GET | `/builder/index-reference` | `?index=QERI|DSM` constituents+prices |

---

## 6. Rebalances

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/rebalances` | filter: portfolio, status, date, trigger |
| GET | `/rebalances/:id` | full record |
| POST | `/rebalances` | create draft (or via builder convert) |
| POST | `/rebalances/:id/approve` | |
| POST | `/rebalances/:id/execute` | apply txs optional; set executed |
| POST | `/rebalances/:id/finalize` | after snapshot + lock |
| POST | `/rebalances/:id/cancel` | |
| POST | `/rebalances/:id/corrections` | final only |
| GET | `/rebalances/:id/compare` | `?otherId=` before/after compare |
| GET | `/rebalances/:id/print` | HTML/PDF payload |

---

## 7. Compliance & risk

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/compliance/run` | body: portfolioId, proposedTrades/targets, timing |
| GET | `/compliance/results` | filters |
| GET | `/compliance/exceptions` | open queue |
| POST | `/compliance/exceptions` | request |
| POST | `/compliance/exceptions/:id/approve` | approver |
| POST | `/compliance/exceptions/:id/reject` | |
| GET | `/risk/alerts` | filters |
| POST | `/risk/scan` | run engine (cron + manual) |
| POST | `/risk/alerts/:id/assign` | |
| POST | `/risk/alerts/:id/resolve` | |
| POST | `/risk/alerts/:id/waive` | approver + reason |
| GET | `/risk/config` | IPS limits |
| PUT | `/risk/config` | admin |

---

## 8. Audit & health

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/audit` | filter objectType, userId, from, to |
| GET | `/audit/:id` | |
| GET | `/system/health` | db, last prices |

---

## 8b. Historical / broker-sheet import (super_admin username only)

Not the IPMS Bulk Upload template. Broker workbooks (`CMClientDetails`, `PMProfitLossTransaction`, `FMClientAccountSummary`, `CB_PRICES`, `CB_SEC_COMP`, `CH_CURRENT_INDEX`). UI: `/data-import` — client list first; Add opens the two profile files (`PMProfitLossTransaction`, `FMClientAccountSummary`), Next previews parsed rows + formulas, then create/update client and commit. Market sheets stay on a separate tab. Gate: `requireSuperAdmin` (username match; generic `admin` role is not enough).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/historical-import/catalog` | Six sheet kinds + required keys |
| GET | `/historical-import` | Import batch registry |
| POST | `/historical-import/preview-portfolio` | Multipart `trades` + `cash` (+ optional `asOf`) → holdings station payload (same formulas as Customer Details; not saved) |
| POST | `/historical-import/commit` | Multipart `file`, `kind`, optional `replace`, `customerId` |
| DELETE | `/historical-import/:id` | Remove tagged trades/cash for that batch |

CLI path remains `npm run db:seed:historical` (files under `backend/historical-data/`). Cash header is detected in **any** column (`Post Date`), not only column 1.

---

## 9. Existing routes to keep

Auth, customers (base), portfolios (base), transactions, stocks (prices/CA), indices, dashboard, sectors — unchanged contracts where possible; **extend responses** with additive fields to avoid breaking the frontend abruptly.

---

## 10. Super-admin portfolio formulas

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/portfolio-formulas` | super_admin | list expressions + `columns` whitelist (id/source). UI picker only; no free-text names |
| PUT | `/portfolio-formulas/:key` | super_admin | update `expression` (safe arithmetic on that key’s `inputs` only) |

Related: `POST /historical-import/validate` and `POST /historical-import/commit` remain the broker-file path (`trades` = PMProfitLossTransaction, `cash` = FMClientAccountSummary). Formula keys include row (`equity_value`, `total_cost`, `profit_loss`, `weight`, `holding_return`, `annualized_return`, `return_contribution`), cash (`cash_total_cost`), KPI (`portfolio_growth`, `portfolio_gain`, `index_performance`), daily (`daily_chg_qar`, `daily_chg_pct`). `GET /portfolios/:id` and `GET /portfolios/:id/phase1` merge `excelWorkbook.indexPerformancePct` and `dailyChanges`. `GET /portfolios/:id` also returns additive `allocation` (cash + sector weights vs NAV; same shape as phase1) so Customer Details does not need a second phase1 payload for holdings. `GET /customers/:id?identity=1` returns the client row + `portfolioId` without holdings/metrics (Customer Details identity fetch).

---

## 10b. Super-admin system config (prices + indices)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/system-config/prices/summary` | super_admin | official close counts + MHAR 2024-12-01 sample |
| GET | `/system-config/prices` | super_admin | list `stock_prices` (`?ticker=&from=&to=&limit=&offset=`) |
| POST | `/system-config/prices` | super_admin | upsert one official close |
| DELETE | `/system-config/prices/:ticker/:date` | super_admin | delete one close |
| POST | `/system-config/prices/import-kb` | super_admin | load `KB/.../Company-Closing-Prices-By-Ticker.md` |
| POST | `/system-config/prices/upload` | super_admin | workbook / csv / md closes |
| GET | `/system-config/indices/summary` | super_admin | QERI/DSM `index_data_points` counts + KB samples |
| POST | `/system-config/indices/import-kb` | super_admin | load `KB/.../Index-Historical-Levels.md` (QERI + DSM only) |

---

## 11. Error contract

```json
{
  "error": "MANDATE_NOT_APPROVED",
  "message": "Trading blocked until mandate is Approved",
  "details": { }
}
```

Use stable `error` codes matching compliance reason codes where applicable.

---

## 12. Background jobs

| Job | Schedule | Action |
|-----|----------|--------|
| Risk scan | daily after price refresh / on-demand | upsert risk_alerts |
| Illiquidity refresh | when ADTV uploaded | set `is_illiquid` |
| Daily snapshot compare | 15:15 Asia/Qatar weekdays when `SNAPSHOT_CRON_ENABLED=true` | read SQL `ClientPortfolioSnapshot`; upsert Postgres `ipms_client_snapshots` |
| Contract expiry reminder | daily | optional stub for F-01 (Phase 2 UI) |

---

## 13. Meta WhatsApp (`/api/whatsapp`)

Admin/pm. All authenticated routes require `?configId=`. Webhook is public (signature + verify token).

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/whatsapp/webhook` | Meta verify + ingest (`messages`, `history`, `smb_app_state_sync`, `smb_message_echoes`) |
| POST | `/whatsapp/sync` | Pull Graph: phone/WABA profile, templates, subscribe WABA. **Does not** GET chat history (Cloud API has none). |
| POST | `/whatsapp/sync/import-webhooks` | Import official Meta webhook JSON (dedupe by `wamid`). Rejects non-Meta CRM dumps. |

Dedup: `whatsapp_messages.wamid` unique; `whatsapp_conversations (config_id, wa_id)` unique.
