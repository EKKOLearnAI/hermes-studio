---
date: 2026-07-26
pr_or_commit: pending
feature: Mixed-runtime Group Chat participants
impact: Group Chat can persist independent Hermes, Codex, and Claude Code participants with stable identities, sessions, scoped runtime settings, and runtime-owned cancellation and approval behavior.
---

# Mixed-runtime Group Chat participants

- Extends persisted Group Chat participants with a stable participant identity, runtime binding, Coding Agent type, independent resumable session, session generation, and participant-level provider/model/API-mode/reasoning settings.
- Allows multiple participants to share one Profile without deduplicating them by Profile.
- Reuses the existing Hermes Bridge and Coding Agent run manager instead of creating a second Codex/Claude process lifecycle.
- Projects canonical Room history into Coding Agent turns and maps text, reasoning, tool calls/results, usage, and workspace-diff evidence back into the Room event log.
- Routes mention options, context status, interruption, removal, and session fencing by stable participant `agentId` while keeping textual `@name` mentions unambiguous through room-local display-name uniqueness.
- Rotates participant sessions after clear-context or a real workspace change; next-run configuration edits keep the current generation and are snapshotted at run start.
- Waits for Coding Agent termination before participant deletion and honors the requested 15-second graceful-stop window before force kill.
- Keeps approval ownership runtime-specific: Hermes participants continue to use Hermes Bridge approvals, while Group Chat Codex/Claude runs use unattended restricted modes (`workspace-write`/no privilege escalation) and are never routed through the Hermes approval responder.
- Adds participant Add/Edit UI, full locale coverage, generated OpenAPI request schemas, migration tests, runtime tests, client-store tests, and mention identity tests.
- Follow-up hardening uses a persisted monotonic Room sequence cursor across pruning, selects Coding Agent participant context with explicit `afterRoomSeq < roomSeq <= throughRoomSeq` bounds before presentation ordering, keeps summary snapshots and UI pagination on their existing canonical presentation order, waits for incompatible runs to stop, persists aborted workspace evidence, isolates Group Chat from inherited external MCP/plugins, and clears stale approval waiters.
- Every Coding Agent input now receives a unique turn fence, proxy streams and child callbacks are tied to a concrete run incarnation, and a replacement run cannot accept delayed events or terminal finalization from the previous incarnation.
- Coding Agent sessions remain processing until terminal usage refresh, workspace-diff completion, terminal publication, and queue/session state finalization have all settled; overlapping input is rejected throughout that lifecycle.
- Does not introduce Room modes and does not modify Workflow behavior.
