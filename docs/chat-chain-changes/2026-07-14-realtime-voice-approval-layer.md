---
date: 2026-07-14
pr: pending
feature: Realtime voice approval overlay
impact: Pending command approvals remain visible and interactive above the realtime voice stage without changing their normal chat layout.
---

The single-chat approval panel keeps its existing message-area placement during
normal chat. While realtime voice is open, only the approval panel is
teleported to the document body and rendered as a fixed highest-priority layer.
Closing realtime voice returns the panel to its original stack with queued and
clarification prompts.
