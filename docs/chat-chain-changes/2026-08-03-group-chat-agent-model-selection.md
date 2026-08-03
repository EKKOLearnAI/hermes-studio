---
date: 2026-08-03
pr: pending
feature: Group chat agent runtime, rolling shared summaries, and response-run cards
impact: Group agents run in fresh isolated sessions from one clean room summary and unsummarized history while preserving their selected runtime configuration and keeping single-chat defaults unchanged.
---

The group chat Add Agent flow now lets room managers choose Hermes, Ekko,
Codex, or Claude. It loads the model catalog for the selected profile and lets
room managers choose a provider, model, and per-agent reasoning effort. Coding
agents also use the same API mode inference and normalization as the single-chat
creation flow. Hermes keeps API mode owned by its provider profile, so group
chat does not persist or forward a caller-selected API mode for Hermes. Agent
names and descriptions keep their previous optional customization and fallback
behavior.

The selected runtime and model configuration is stored on `gc_room_agents` and
restored after a server restart. Hermes continues to use Agent Bridge directly;
Ekko, Codex, and Claude reuse the existing chat-run dispatcher used by their
single-chat counterparts. Group session IDs include the complete runtime
selection so changing an Agent type, model, or reasoning effort cannot reuse a
stale session. Coding-agent session IDs also include API mode. Existing rows
default to Hermes and continue to resolve their profile's configured default
model.

Every Agent reply now has a persisted `run_id`. All assistant parts and tool
rows from that reply share the same run ID, while `tool_call_id` pairs each call
with its result inside the run. The client renders one Agent card per run, so
interleaved `@all` replies cannot mix tool traces between Agents. Legacy rows
without `run_id` are grouped when their generated message IDs still contain the
older response-part prefix.

Group chat forces Hermes background delegation off. Ekko receives the same
policy and enforces it inside the runtime: its `delegate_task` schema exposes
foreground mode only and rejects attempted background delegation. Ordinary
single-chat behavior is unchanged.

Room cloning preserves each source agent's runtime selection. A profile is now
only a runtime configuration source, so the same room may contain multiple
agents backed by the same profile. Mention routing, room membership, and agent
name and description behavior remain unchanged.

Room creation now selects the provider, model, API mode, and human-turn interval
used for rolling room summaries. Before an Agent run crosses that interval, a
bare isolated Ekko Agent updates the previous summary from the next clean
message window. The shared context contains only human messages and assistant
final text; reasoning, tool calls, tool results, and workspace traces are not
replayed. Summary state and its message anchor are persisted, visible, editable,
and retained when a summary attempt fails.

Hermes, Ekko, Codex, and Claude group replies now start from a fresh ephemeral
runtime session for every run. They receive the same room summary plus
unsummarized shared history and do not continue an Agent-specific chat history.
The group path explicitly disables chat-run context compression for these
ephemeral sessions; ordinary single-chat callers omit that option and retain
their previous compression and session behavior.

Each run also rebuilds the existing group system prompt from the current room
name, Agent name and description, human members, Agent members, and group
handoff rules. Hermes receives it through Agent Bridge instructions, Ekko
receives it as a system message, and Codex and Claude receive it as their
coding-agent system prompt. This group-only injection does not replace or alter
the single-chat prompt path. Each room Agent has one stable group-only scoped
config directory. Codex and Claude overwrite that Agent's `config.toml` or
`hermes-rules.md` before launching a fresh execution session, so replies do not
accumulate per-run config directories and do not write into single-chat scoped
config. Proxy targets remain isolated by chat session and Agent session IDs, so
group and single-chat runs can execute concurrently.

Room creation and room-level settings use right-side drawers. The settings
drawer includes the room name, invite code, validated workspace directory,
summary configuration, status, anchor navigation, and manual editing, and
relies on its header close control without a duplicate footer button. Room
managers also get the same combined workspace, terminal, and desktop-browser
tool drawer used by single chat, gated by the existing room-management
permission.

When room creation does not provide an explicit workspace, the server creates
and persists `<HERMES_WEB_UI_HOME>/group-chat/<profile>/<room-id>`, using the
room summary profile and generated room ID. Explicit user-selected workspaces
remain authoritative.
