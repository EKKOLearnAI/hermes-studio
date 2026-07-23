---
date: 2026-07-23
pr: 2198
feature: Windows browser toolbar layout
impact: Embedded browser navigation icons render consistently on Windows, and the custom title bar now fills space released by collapsed route-owned sidebars.
---

The embedded browser uses SVG paths for back, forward, reload, and stop
controls instead of platform-font Unicode glyphs.

Single chat, Global Agent, history, workflow, and group chat surfaces publish
their local sidebar state to the app shell. The Windows custom title bar uses
that state to remove its left offset when the page sidebar is fully collapsed.
Message delivery, session persistence, and group chat runtime behavior are
unchanged.
