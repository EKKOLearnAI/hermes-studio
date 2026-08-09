---
date: 2026-08-09
pr: 2451
feature: Group Chat agent turn timeout configurable
impact: Room-agent Hermes turns now use a configurable timeout instead of the hardcoded 120s, so long real tasks no longer die at the 120s ceiling.
---

Group Chat room-agent turns previously ran with a hardcoded 120000ms
deadline in the Agent Bridge streaming path (`streamOutput` timeout), which
killed long real tasks (read → fix → test → commit → docs) with
"chat-run timed out after 120000ms" (#2386).

The timeout is now read from `HERMES_GROUP_CHAT_AGENT_TURN_TIMEOUT_MS`
(defaulting to 120000 when unset or invalid), mirroring the existing
`HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH` env-based configuration in the
group-chat runtime. The stream wait between starting a run and reading the
first chunk uses the configured value, so deployments with longer-running
agents can raise the ceiling without a code change.
