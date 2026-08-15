---
date: 2026-08-15
pr: 2564
feature: Lazy complete Group Chat history pagination
impact: Complete history opens at the newest page and loads one stable-ID page upward without losing the reader's viewport anchor.
---

# Issue #2563: lazy Group Chat history pagination

## Behavior impact

- The read-only complete-history page opens on the newest 150 messages and at
  the bottom of the transcript instead of downloading the full room history.
- Reaching the top loads exactly one earlier page by stable message-ID cursor.
  Prepending keeps the current reading anchor stable and de-duplicates IDs.
- Loading, retry, and earliest-message states are explicit.
- SQLite keyset pagination uses `(roomId, timestamp DESC, id DESC)`, so histories
  above 13,000 messages and equal-timestamp boundaries remain continuous.
- A nominal 150-message page expands at its oldest edge when necessary to keep
  one Agent run intact. Viewport anchoring follows the grouped run card's real
  DOM identity, so loading an earlier page neither splits the run nor jumps the
  reader to the newly inserted messages.
- Existing room access checks, route identity, refresh/back navigation, shared
  archive entry, read-only rendering, and Agent run aggregation remain in place.
