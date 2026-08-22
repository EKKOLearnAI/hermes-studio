---
date: 2026-08-22
pr: 2677
feature: Group Agent interrupt approval settlement
impact: Interrupting an exact Group Agent run generation now denies its pending approvals in both the runtime and browser while leaving other runs untouched.
---

Approval cancellation is idempotent and uses deny-only test commands so interrupted work cannot be approved accidentally.
Approval routes and Agent Bridge waiters are bound to the exact Session + run generation; legacy or malformed empty generations are never claimed by an interrupt, and a later run in the same Session remains isolated.
