# 13 — Ops Forms Mapping (Arabic Annex)

Source: الإجراءات التشغيلية لإدارة اتفاقيات المحافظ الاستثمارية — نماذج العمل

These forms are **operational governance** between Investment, Finance, and IT. Most automation belongs to **Phase 2 (Performance & Fee Management)**. Phase 1 must not block them later.

---

## Forms

| Code | Title (AR) | Phase | Phase 1 data dependency |
|------|------------|-------|-------------------------|
| F-01 | إخطار انتهاء العقد | Phase 2 UI; Phase 1 optional reminder stub | `mandates.effective_to` / contract end date field |
| F-02 | اعتماد احتساب الرسوم الشهرية | Phase 2 | Month-end NAV + fee inputs; approval audit pattern |
| F-03 | تعليمات تجديد اتفاقية إدارة الاستثمار | Phase 2 | Mandate amend/renew workflow extends mandate status |
| F-04 | تحديد القيمة الابتدائية عند التجديد | Phase 2 | Opening NAV / initial value field on mandate period |
| F-05 | معالجة التوزيعات النقدية | Phase 2 (CA depth) | Cash ledger + dividend cash txs (Phase 1 cash types include dividend) |
| F-06 | اعتماد نتائج الإقفال الشهري | Phase 2 | Reconciliation gate; Phase 1 provides holdings+cash integrity |

---

## Phase 1 schema hooks (implement lightly)

On `mandates` or related `investment_agreements` (optional table):

- `contract_start`, `contract_end`  
- `initial_value` (القيمة الابتدائية) nullable  
- `fee_notes` text nullable  

Do **not** build fee calculation engine in Phase 1.

---

## Procedural controls already aligned with Phase 1

| Ops rule | Phase 1 support |
|----------|-----------------|
| No fee deduction without Investment approval | Future; use same approval+audit pattern as rebalance |
| Monthly portfolio review completeness | Holdings+cash+txs integrity |
| NAV from official QSE closes | `stock_prices` + valuation services |
| IT updates system after Investment instruction | Role-gated mutations + audit |

---

## Recommendation

Track F-01–F-06 as a **Phase 2 epic**. Mention in client demos that Phase 1 delivers the controlled portfolio core those forms will sit on.
