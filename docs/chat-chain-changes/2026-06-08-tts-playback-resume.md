---
date: 2026-06-08
pr: pending
feature: TTS playback resume safety
impact: Preserves run markers and completion state so resumed chat runs do not replay stale assistant audio.
---

The chat store and server message formatter now preserve finish-reason fields and pass through run markers when they are available, allowing playback logic to distinguish active resumed output from completed historical messages without replaying stale audio.
