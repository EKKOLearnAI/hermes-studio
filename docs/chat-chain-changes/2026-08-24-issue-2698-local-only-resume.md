---
date: 2026-08-24
pr: 2717
feature: Defer local-only session resume
impact: Newly created chats avoid user-visible resume failures before their first run persists the session.
---

Session switching and foreground visibility resync skip resume while a session is
still client-only. If the run socket reconnects during that admission window, the
client probes resume with capped backoff, suppressing transient `Session not found`
failures until the original session ID is available. The first `run.started` event
marks that ID as persisted, after which normal resume behavior is restored.
