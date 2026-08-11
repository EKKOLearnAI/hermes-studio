---
date: 2026-08-08
pr: 2415
feature: Manual group chat room link copy fallback
impact: Users can retrieve a room invite link when browser clipboard APIs are unavailable or fail.
---

Successful one-click copying remains unchanged. When both the modern Clipboard
API and the legacy copy command fail, the group chat panel opens an accessible
dialog containing the complete room link, focuses the read-only field, and
selects the link for manual copying.
