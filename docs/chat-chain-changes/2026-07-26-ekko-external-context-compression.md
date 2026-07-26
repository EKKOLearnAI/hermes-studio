---
date: 2026-07-26
pr: pending
feature: Externally managed Ekko context compression
impact: Web UI-hosted Ekko conversations now use the shared snapshot-aware compression chain before each run instead of sending the loaded display history directly to Ekko.
---

The Ekko chat handler now rebuilds model history from the database, applies the
same automatic compression thresholds and persistent compression snapshots as
Hermes chat, and appends the current input after the compressed history.
Provider-visible fixed context is estimated from Ekko's system prompt, tools,
and provider context before the threshold decision. Compression progress uses
the existing `compression.started` and `compression.completed` socket events.
Ekko conversations explicitly disable the shared Hermes Agent summarization
fallback; Hermes conversations retain it.

The clean Ekko summarizer preserves the selected provider's streaming
capability. This avoids holding a large summary request open without response
data until the entire completion is ready, which can trip shorter upstream
gateway timeouts even though the local summarization timeout is five minutes.

Context ownership remains with the host: this Web UI path manages compression
externally, while a future standalone Ekko host can manage its own internal
compression without depending on Web UI snapshot storage.
