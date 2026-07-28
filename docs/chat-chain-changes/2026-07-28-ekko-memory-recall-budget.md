---
date: 2026-07-28
pr: 2246
feature: Ekko memory recall budget
impact: Automatic durable-memory recall now uses a fixed 4000-token budget instead of a 12-card cap.
---

Durable memory storage remains unbounded by the recall budget. On each
foreground run, Ekko first considers globally applicable interaction rules,
language and accessibility needs, hard constraints, and corrections. Controlled
categories such as food avoidances, identity, location, projects, goals, and
tool preferences are recalled when the current request indicates that category.
Ekko then fills the remaining 4000-token budget with textually relevant
memories. Ordinary preferences and facts are no longer injected merely because
they are recent or important.

Text search now filters and ranks against the full profile memory table before
applying the 500-candidate processing bound. This prevents an old but relevant
memory from disappearing solely because it was outside the former
importance-ordered 100/150-row candidate window.

The explicit `memory_search` tool remains independently bounded: it defaults
to 12 results and is clamped to at most 50 by both its schema and the service
runtime. Recall diagnostics now report the token budget and the tokens used.
