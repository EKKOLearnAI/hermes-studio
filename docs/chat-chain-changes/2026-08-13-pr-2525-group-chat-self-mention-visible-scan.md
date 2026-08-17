---
date: 2026-08-13
pr: 2525
feature: Group Chat self-mention visible scan exclusion
impact: Agent messages that mention both the sender and another participant are no longer rejected as Invalid structured mentions; only the other participant is routed.
---

`normalizeStructuredMentions()` now excludes the sender from the visible @ scan, matching `resolveMentionTargets()`. A mixed `@self + @other` message with structured mentions that omit self persists and routes only the other agent.
