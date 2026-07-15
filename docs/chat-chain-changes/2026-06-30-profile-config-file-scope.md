---
date: 2026-06-30
commit: pending
feature: Chat file drawer profile scope reset
impact: Chat file drawer explicitly uses the active profile instead of inheriting a scoped profile-config editor route.
---

The profile config edit affordance opens the Files view with an explicit `profile` and `file=config.yaml` query. The chat file drawer now clears that scoped files-store profile on mount so chat attachments and file operations do not accidentally target the last profile-config editor scope.
