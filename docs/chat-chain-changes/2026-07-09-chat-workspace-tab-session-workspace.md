---
date: 2026-07-09
pr: pending
feature: Chat workspace side panel
impact: The chat side-panel workspace tab now opens the active chat session workspace when that session has one, and falls back to the existing file-browser directory when no session workspace is available.
---

The chat-side workspace panel is now session-aware. When the active chat has a
stored workspace, the files tab lists and edits files relative to that session
workspace instead of the Hermes profile directory. When the active chat has no
workspace, the panel returns to the regular file-browser mode and preserves the
previous regular directory.

Session workspace file access goes through session-scoped endpoints so paths are
resolved under the stored session workspace and remain isolated from the Hermes
profile file browser. The terminal tab behavior is unchanged.

Bridge-backed chat runs emit `session.workspace.updated` after the server has
created or filled the session workspace. The client uses that event to stop
treating a new local chat as local-only and then switches the workspace tab to
the session-scoped file APIs. The file list clears stale entries during mode or
path changes, and the tree sidebar is remounted when the workspace context
changes so it does not retain directories from the previous workspace.

Socket resume payloads also include the stored workspace so a page refresh that
auto-selects the first session can hydrate `activeSession.workspace` before the
user opens the workspace tab.
