---
date: 2026-07-09
pr: 2004
feature: Agent session lifecycle
impact: Agent runs now persist session end markers on terminal completion or abort and reopen ended sessions when a new run starts.
---

Hermes bridge, coding-agent, and ekko-agent runs write `ended_at` and
`end_reason` when the run terminates without another queued run. Explicit aborts
write `end_reason: abort` when no queued run will continue the session. Starting
a new run on an existing session clears those fields and refreshes
`last_active`, so database-backed session summaries can distinguish a completed
or aborted run from a session that is actively running again.
