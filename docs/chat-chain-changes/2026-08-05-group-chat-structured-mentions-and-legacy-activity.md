---
date: 2026-08-05
pr: pending
feature: Group-chat structured Agent mentions and legacy activity ordering
impact: Agent handoffs preserve a verified structured routing identity, while legacy rooms retain only safely inferred compatibility activity ordering.
---

Agent replies now generate entry mention DTOs with both the target participant ID
and display name. The server verifies the visible mention against room authority,
persists only the participant ID routing DTO, and reuses that DTO for subsequent
Agent scheduling. Invalid, cross-room, duplicate, self-directed, or unstructured
Agent mention metadata is rejected atomically.

Legacy group-chat databases receive compatibility activity times only when a
historical visible message timestamp is positive, not later than the migration
cutoff, and is neither a tool nor streaming record. Missing legacy room creation
times are derived only from those compatibility times; otherwise they remain
unknown (`0`) and sort as oldest. New rooms and messages use server-side time.
