---
date: 2026-07-27
pr: pending
feature: Ekko Agent guarded skill evolution
impact: Ekko Agent can create and safely refine reusable profile skills during foreground runs, then asynchronously review tool-heavy sessions for durable procedures without modifying manually authored skills.
---

`skill_manage` supports full skill creation, targeted patches, full edits,
support-file writes and removals, and recoverable skill archival. Existing
targets require a same-run `skill_view` with an unchanged content hash.
Overwrites are backed up, paths are constrained to the configured profile skill
root, and confirmed deletes are moved into a hidden archive.

Ekko owns its storage through one directory manager. Given a base directory, it
creates `<base>/.ekko/skills`; the database is `<base>/.ekko/ekko.db`, and each
profile's skills, backups, archives, and provenance stay below
`<base>/.ekko/skills/<profile>` instead of the Hermes home.

On first initialization only, when `.ekko/skills` does not exist, the directory
manager copies the default and every named Hermes profile's skills into the
matching Ekko profile directory. Existing Ekko skill storage is never resynced
or overwritten.

Each Ekko profile also owns one bounded structured log at
`.ekko/logs/<profile>/ekko-agent.jsonl`. It records run, model, tool, context,
skill, memory, and system lifecycle events without streaming deltas or raw
secrets. At 10 MiB the old content is discarded and the same file continues;
there are no rotated or per-session files. The existing Web UI Logs page reads
and filters this source.

Completed Ekko tool groups are persisted incrementally as one SQLite
transaction containing the assistant tool calls and every matching tool result.
If a later model request or long-running tool is aborted, earlier completed
groups remain in session history and follow-up turns do not need to rediscover
the same skill or repeat the same completed tool work. Successful run
finalization skips groups already stored by the event path.

Ekko exposes the provider API mode when creating a scoped chat and when
switching its model. The selected value is kept in session and run data, and
an explicit mode such as `codex_responses` reaches the runtime. If an older
client or session omits it, the server restores the mode from the profile's
provider configuration before falling back to provider and base-URL inference.
Responses requests replay the complete local conversation and keep
`store: false`; they do not also send `previous_response_id`, which avoids
invalid second-turn chaining and accidental fallback to another wire protocol.

Every 10 cumulative non-management tool calls in a session, Ekko schedules a
separate conservative skill-review run. The reviewer receives a bounded
transcript and only the three skill tools. It may create a new reusable skill,
but it may update only skills carrying Ekko provenance and may never delete.
Review model usage and lifecycle events are recorded separately from the
foreground turn.
