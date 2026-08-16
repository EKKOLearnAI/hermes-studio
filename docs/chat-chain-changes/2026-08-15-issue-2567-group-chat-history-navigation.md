---
date: 2026-08-15
pr: 2568
feature: Unified Group Chat complete history navigation
impact: Hermes History exposes authorized rooms under GROUP, while live rooms use an authoritative 500/501 boundary to discover stable-cursor complete history.
---

# Issue #2567: unified Group Chat history

- Hermes History lists authorized rooms in a paged `GROUP` section ordered by
  authoritative room activity. Selecting a room keeps the common History shell
  visible and opens the canonical read-only route.
- Complete room history opens on the newest bounded page, loads older records in
  150-row stable message-ID pages, preserves the viewport anchor, de-duplicates
  raw IDs, and keeps Agent runs intact across page boundaries.
- Live room responses expose `historyTruncated` from retained SQLite data. The
  complete-history entry appears only after the recent 500-message window has
  been reached and retained history exceeds that window, including immediately
  when the 501st persisted realtime message crosses the boundary.
- Existing room authorization is reused for both listing and direct history
  access; anonymous invite-only access is not added to account History.
