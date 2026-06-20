---
date: 2026-06-13
pr: 1531
feature: Thinking indicator refresh
impact: Chat active-run rendering now shows the thinking avatar, localized status, and elapsed time above tool calls without changing message payload or history semantics.
---

The thinking media assets were consolidated to one GIF and Hermes empty states now use the Hermes agent logo. These are visual-only client changes; persisted message ordering, tool-call records, and session loading behavior remain unchanged.
