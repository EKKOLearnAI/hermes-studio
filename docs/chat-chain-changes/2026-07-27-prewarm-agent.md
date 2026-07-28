---
date: 2026-07-27
pr: 2241
type: improvement
feature: agent-warmup
impact: On Socket.IO connection to /chat-run, the bridge pre-warms the Hermes Agent
  for the connection's profile by calling contextEstimate with a throwaway session ID.
  This reduces first-message cold-start latency from ~15s to ~1-2s.
