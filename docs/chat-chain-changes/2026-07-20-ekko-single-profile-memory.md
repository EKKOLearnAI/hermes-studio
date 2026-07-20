---
date: 2026-07-20
pr: pending
feature: Ekko single profile memory
impact: Ekko structured memory no longer exposes session, workspace, user, or global scopes. All durable memory is isolated by Hermes profile. A dedicated memory-only agent reviews every completed user turn by default; high-signal identity, relationship, preference, workflow, correction, and forget statements bypass any explicitly configured batching threshold without requiring a "remember" command. Corrections or exact deletes resolve existing memories before writing.
---

The memory schema is reset to version 3 without migrating old scope data. Existing
memory tables are dropped and recreated when the new migration runs. Session message
logs and rolling summaries remain internal continuity state rather than separate
user-visible memory kinds.

Memory keys are now server-owned. The curator submits a controlled kind and optional
item key; Ekko maps them to one canonical active slot per profile. Every injected or
searched card includes its id, canonical key, revision, structured value, and content.
Updates and exact deletes require id plus expected revision, while object memories can
be changed with field-level set/unset patches. Stale writes are rejected and duplicate
creates in the interaction-relationship slot automatically supersede the prior card.
Controlled entities are regenerated from the current structured value, and the runtime
attaches server-owned source message ids plus the triggering session id to write audits.
Explicit memory search requires a real lexical or filter match, while automatic context
may still include always-applicable preferences, constraints, and corrections.

The memory curator receives only memory search/get/update/forget tools. Its distilled
prompt applies general durability, provenance, and conflict-resolution tests. It treats
interaction contracts as requested behavior rather than objective relationships, keeps
transient state out of profile memory, and rejects durable claims derived only from
assistant statements, tool output, external results, defaults, or incidental behavior.
