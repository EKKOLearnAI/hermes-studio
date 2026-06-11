---
date: 2026-06-11
pr: TBD
commit: pending
feature: Agent Bridge Python module layout
impact: No protocol or chat behavior change. The Python bridge now lives under a dedicated `agent-bridge/python/` directory and is split into focused modules; server and desktop builds copy that directory into `dist/server/agent-bridge/python/`.
---

The Python bridge entrypoint moved to `packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py`. The implementation is split across `bridge_*.py` modules for runtime helpers, session pool, worker server, socket transport, and broker routing.

`scripts/build-server.mjs` now copies the Python bridge directory into `dist/server/agent-bridge/python/`, which is also the path bundled by desktop packaging through `dist/**`.
