---
date: 2026-07-11
pr: pending
feature: Chat-run profile socket reuse
impact: Omitted-profile chat-run socket requests now reconnect when the active Hermes profile has changed instead of reusing a socket for the previous profile.
---

Explicit same-profile chat-run socket requests still reuse the connected socket.
