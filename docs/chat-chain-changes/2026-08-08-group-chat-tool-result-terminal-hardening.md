---
date: 2026-08-08
pr: pending
commit: pending
feature: Group Chat Tool terminal persistence hardening
impact: Hermes failed Tool results keep their original error payload; stale runs release scoped recovery state after final retry; and active runs surface terminal persistence loss while clearing exhausted ephemeral state.
---

- Preserve Hermes bridge `tool.failed` payloads and persist them as failed Tool results instead of synthesizing empty completions.
- Drain and retry queued Tool writes before run exit. Stale runs discard only their scoped recovery state; active runs that exhaust retries log and surface terminal persistence loss, then clear the exhausted ephemeral correlation state.
- Keep server-side stale-session authorization intact; stale runtime cleanup does not bypass Room message validation.
