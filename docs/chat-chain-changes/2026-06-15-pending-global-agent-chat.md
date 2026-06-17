---
date: 2026-06-15
pr: pending
feature: Global Agent chat transport
impact: Adds a global-agent chat route that reuses single-chat UI behavior while isolating sessions with source global_agent and forwarding run-chat events through a local relay.
---

Global Agent chat uses the same store, session controls, attachment flow, and
run-chat event names as single chat, but switches the Socket.IO namespace and
session filtering when the Global Agent route is active.
