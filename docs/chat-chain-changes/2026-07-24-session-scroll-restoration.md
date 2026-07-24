---
date: 2026-07-24
pr: pending
feature: Session scroll restoration and switch ordering
impact: Returning to a conversation keeps a bottom-following transcript pinned after delayed content rendering, and rapid session switches no longer apply stale list or resume responses.
---

The live transcript now observes rendered content height as well as the scroll
viewport. When a saved session position was at the bottom, delayed image,
highlighting, table, or other layout changes keep the view pinned until the
user deliberately scrolls away.

Session-list loads and session resume requests use request ordering guards.
Message-loading state is scoped to the latest request for each session, so an
older request cannot clear or overwrite the state of the conversation that the
user most recently selected.

Server-side chat history and message persistence are unchanged.
