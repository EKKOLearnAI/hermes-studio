---
date: 2026-08-22
pr: 2667
feature: Queue insertion for one-shot coding agents
impact: Queued messages can interrupt active Claude Code, Codex, and Pi turns, preserve partial output, and resume as a new user turn while Hermes and Ekko retain strict tool-boundary insertion.
---

Claude Code, Codex, and Pi use immediate child-process interruption because
their current one-shot integrations do not expose a synchronous pre-model tool
boundary. Studio waits for the interrupted process streams to close, persists
the partial assistant response, and then starts the selected queued message
through the existing native-session resume path.

The chat protocol reports these runs with `guarantee: immediate` and
`interruption_mode: immediate`; it does not present them as strict tool-boundary
stops.
