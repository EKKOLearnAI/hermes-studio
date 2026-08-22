---
date: 2026-08-22
pr: 2677
feature: Group Agent interrupt approval settlement
impact: Interrupting an exact Group Agent run generation now denies its pending approvals in both the runtime and browser while leaving other runs untouched.
---

Approval cancellation is idempotent and uses deny-only test commands so interrupted work cannot be approved accidentally.
