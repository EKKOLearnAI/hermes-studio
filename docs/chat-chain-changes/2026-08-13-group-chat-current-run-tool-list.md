---
date: 2026-08-13
pr: 2527
feature: Group Chat current-run tool list
impact: Active Agent runs show their tool calls in an Agent/Run-scoped bounded scroll region while completed runs keep tool traces in the transcript.
---

The panel is a view over existing runtime messages, not a second persisted source.
Wheel input stays inside the panel while it has remaining scroll range and naturally
returns to the outer transcript at either boundary.
