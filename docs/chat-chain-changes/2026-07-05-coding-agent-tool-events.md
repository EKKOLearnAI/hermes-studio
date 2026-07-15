---
date: 2026-07-05
pr: pending
feature: Coding-agent tool event status
impact: Coding-agent tool failures now surface as tool.failed events with duration metadata while successful tools continue to emit tool.completed.
---

The Responses stream mapper now aligns coding-agent tool status events with the
Hermes ekko-agent path by emitting `tool.failed` for failed tool outputs and
preserving duration metadata on completed or failed tools. The chat UI continues
to consume both terminal tool event names and now displays zero-second tool
durations instead of hiding them.
