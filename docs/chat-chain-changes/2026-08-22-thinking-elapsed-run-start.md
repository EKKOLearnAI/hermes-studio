---
date: 2026-08-22
feature: thinking-timer-counts-from-the-real-run-start
pr: 2693
impact: The thinking timer shows how long the agent has actually been working instead of counting from the client's first render. No change to when the indicator appears or to run handling.
---

# Thinking timer origin

`MessageList` started the elapsed clock with `thinkingStartedAt = Date.now()` the moment the run indicator became visible. That is the client's first render, not the run's start, so leaving a page mid-run and coming back showed the agent as having just started, and two devices watching one run disagreed — the one that stayed open kept counting, the one that navigated reset to zero.

The run's start is only known server-side, so `SessionState` now carries `runStartedAt`, set for direct, queued, background, and reattached runs, and it is included in the `resumed` payload. The chat store keeps it per session, refreshes it on every live `run.started`, clears it on terminal events, and the timer uses it as its origin.

`Date.now()` remains the fallback when the value is absent, so a client talking to an older server behaves exactly as it does today rather than showing nothing.

Nothing else changes: the indicator's visibility rule, the one-second tick, and the formatting are untouched.
