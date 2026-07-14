---
date: 2026-07-14
pr: 1924
feature: Session workspace file path normalization
impact: Session-scoped workspace APIs accept legacy profile-relative workspace paths without changing generic file routes.
---

Session workspace file routes now normalize the legacy profile-relative `workspace/...` path shape to a session-relative path and leave already session-relative paths unchanged. Generic `/api/hermes/files/*` routes are not modified.
