---
date: 2026-08-24
pr: 2718
feature: Per-session social message push
impact: Direct-chat sessions can persist an independent message-push toggle and deliver localized completion, approval, or clarification notifications through the active configured social channel.
---

The session setting is stored in SQLite, exposed through the session API, and
restored with the existing chat state. Runtime notification delivery is
best-effort: clearing or disconnecting every social channel while a session is
still opted in skips delivery without interrupting the chat run.
