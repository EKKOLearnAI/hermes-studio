---
date: 2026-08-22
pr: 2671
feature: Server-persisted session reasoning effort
impact: Single-chat reasoning effort now follows the session across clients, resets to the model default after model changes, and is inherited by new runs without localStorage.
---

The Web UI stores the override on the session row and broadcasts updates to
other clients currently watching that session. The resumed-session snapshot
also carries the persisted model, provider, API mode, and reasoning effort so
clients that missed an event while disconnected reconcile after reconnect. A
local-only empty chat keeps the value in memory until its first run creates the
server session. The mobile App consumes the same session field, update route,
live settings event, and resume snapshot instead of localStorage. Group-chat
agents continue using their existing server-persisted setting, while every
group-chat model-selection entry point now resets the override to default.
