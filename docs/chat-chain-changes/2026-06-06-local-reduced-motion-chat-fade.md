---
date: 2026-06-06
pr: 1351
feature: Chat message list fade under reduced motion
impact: Chat session message lists still use the opacity-only fade-in when browsers report prefers-reduced-motion.
---

`VirtualMessageList` no longer disables the message-list opacity fade when Chromium reports `prefers-reduced-motion: reduce`, which keeps the chat entry/session-switch fade visible on Windows systems with OS animation effects disabled.
