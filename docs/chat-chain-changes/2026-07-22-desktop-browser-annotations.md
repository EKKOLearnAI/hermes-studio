---
date: 2026-07-22
pr: pending
feature: Desktop browser annotations
impact: Element and region selections from the desktop browser are added to the chat composer as an image plus structured page context without sending automatically.
---

The desktop-only browser keeps its pending annotation payload in renderer memory
while routing back to Chat. The next composer consumes the screenshot and safe
selection metadata exactly once; ordinary Web UI and existing attachment flows
are unchanged. Pending images expire after five minutes if no composer consumes
them.
