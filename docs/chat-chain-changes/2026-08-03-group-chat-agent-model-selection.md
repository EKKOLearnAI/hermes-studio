---
date: 2026-08-03
pr: pending
feature: Group chat agent runtime, model selection, and response-run cards
impact: Newly added group chat agents persist and run as Hermes, Ekko, Codex, or Claude with isolated tool traces and their selected profile, provider, model, API mode, and reasoning effort.
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
