---
date: 2026-08-23
pr: pending
feature: Authenticated shared-profile session and memory isolation
impact: New authenticated bridge sessions persist their owner user_id; user-facing session lists, details, and Socket.IO continuation access exclude sessions owned by other accounts. The memory editor stores authenticated users' files in account-specific directories beneath the shared profile.
---

Profile configuration remains shared. Existing ownerless rows retain their historical behavior for backward compatibility; newly created authenticated sessions are account-bound.
