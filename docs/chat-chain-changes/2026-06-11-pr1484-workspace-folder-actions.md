---
date: 2026-06-11
pr: 1484
feature: Workspace folder actions
impact: Chat workspace selection gains folder create, rename, delete, open, and copy path actions without changing session run protocol, message persistence, resume, or queue behavior.
---

- The workspace folder picker now uses explicit folder-management endpoints scoped to the configured workspace base.
- Existing session workspace values are only cleared when the selected folder is deleted or renamed, so active chat execution behavior is unchanged.
