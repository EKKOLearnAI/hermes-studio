---
date: 2026-08-15
pr: pending
feature: Bounded group-chat history pagination
impact: Group-chat realtime joins can request a bounded initial history page, while REST pagination stops at the same 500-message UI window instead of advertising unavailable older pages.
---

Group-chat realtime joins accept an optional `historyLimit` and clamp it to the
server's normal 1-150 message page range before loading history. Existing
clients that omit the field keep the 150-message default.

The room-detail REST route now reports `total` within the shared 500-message UI
window. `hasMore` therefore becomes false when a client reaches that boundary,
matching the storage window already used by realtime history and preventing a
successful final page from being presented as another available page.
