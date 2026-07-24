---
date: 2026-07-24
pr: pending
feature: Standalone desktop chat window
impact: Desktop sessions can open in a native-chrome, sidebar-free chat window while Web sessions keep opening in a normal browser tab.
---

The standalone route reuses the existing single-chat view, store, message list, and input. It only suppresses the session sidebar and chat header when hosted by the dedicated Electron window; session loading, Socket.IO resume, streaming, approvals, persistence, and queue behavior are unchanged.
