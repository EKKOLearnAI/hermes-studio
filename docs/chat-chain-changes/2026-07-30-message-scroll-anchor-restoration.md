---
date: 2026-07-30
pr: pending
feature: Message scroll anchor restoration
impact: Live chat and history views restore the previously visible message without sharing scroll state across profiles or surfaces.
---

Message scroll snapshots now include the top visible message and its viewport offset. Scroll state is scoped by surface, profile, and session; when the saved message is no longer available, the transcript falls back to the bottom instead of applying a stale pixel offset.
