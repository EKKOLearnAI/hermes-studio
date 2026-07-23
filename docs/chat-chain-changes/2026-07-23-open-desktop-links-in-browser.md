---
date: 2026-07-23
pr: pending
feature: Open chat links in the Desktop browser
impact: Desktop single-chat and group-chat links and HTML workspace files open in the embedded browser while Web behavior remains unchanged.
---

Desktop single-chat and group-chat message links now open in the embedded
browser. Opening an HTML workspace file sends its already-authenticated content
to an isolated browser preview tab instead of rendering the Web UI iframe.

The Web UI keeps its existing external-tab behavior and restrictive HTML iframe
preview. Local HTML preview tabs are not persisted, so raw preview content is
not written into the browser profile tab history.
