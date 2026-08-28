# 12 — Security & RBAC (Phase 1)

---

## Roles

| Role | Capabilities |
|------|----------------|
| **admin** | Users, IPS config, stock classification, all read; avoid day-to-day approve conflict in prod |
| **pm** | Clients, mandates draft/submit, builder, propose rebalance, cash, resolve risk (not waive), execute rebalance |
| **compliance** | Compliance dashboard, run checks, comment; may approve exceptions if policy says so |
| **approver** | Approve mandates, approve rebalances, approve/waive exceptions, finalize |
| **viewer** | Read-only all Phase 1 screens |

Phase 1 UAT may assign multiple roles to one user; production should segregate **pm** vs **approver** for mandates/rebalances.

---

## Authorization matrix (high level)

| Action | admin | pm | compliance | approver | viewer |
|--------|-------|----|------------|----------|--------|
| Login / read portfolios | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit mandate fields | ✓ | ✓ | | | |
| Approve mandate | ✓ | | | ✓ | |
| Edit stock tags | ✓ | ✓ | | | |
| Builder convert | ✓ | ✓ | | | |
| Approve rebalance | ✓ | | | ✓ | |
| Finalize rebalance | ✓ | | | ✓ | |
| Request exception | ✓ | ✓ | ✓ | | |
| Approve exception | ✓ | | ✓* | ✓ | |
| Waive risk alert | ✓ | | | ✓ | |
| View audit | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage users | ✓ | | | | |

\* Optional: treat compliance role as exception approver — confirm with QSC.

---

## Technical controls

1. JWT includes `sub` (user id) + `role`.  
2. Middleware `requireRole(...roles)`.  
3. Mandate gate middleware/service on transactions + builder convert.  
4. Audit writer on all rows in matrix that mutate.  
5. No delete endpoint for `audit_logs`.  
6. Passwords bcrypt; change default `admin/admin` before any shared environment.  
7. CORS tighten for production origin.  
8. Secrets in env (`JWT_SECRET`, DB URL, Gemini key).

---

## AI governance (Phase 1 note)

Existing sector AI remains **analysis-only**:

- Must not execute trades  
- Must not approve trades/mandates  
- Must not calculate or approve fees  
- Must not override compliance  

Document on Audit/Admin page as a fixed policy banner.
