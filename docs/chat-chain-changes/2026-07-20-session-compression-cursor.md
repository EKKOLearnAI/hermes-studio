---
date: 2026-07-20
pr: pending
feature: Stable session compression cursor
impact: Hermes chat resumes use bounded display reads, while compressed runs load only the protected head and messages after a stable database cursor.
---

Compression snapshots now retain message cursor, protected-head cursor, and
history revision fields alongside the legacy array index. First compression
still reads the complete unsummarized history; later compression and usage
paths batch the post-cursor range and do not reload message bodies represented
by the summary. Forced compression and compressed exports use the same bounded
path. Legacy snapshots remain index-based until a successful real compression
cycle upgrades them.

Clearing or deleting history invalidates the snapshot transactionally, stale
in-flight summaries fail the revision compare-and-swap, and branches remap
cursor IDs to the child rows. Socket resume uses its latest display page plus
persisted usage, and Coding Agent usage uses native records rather than Web UI
history reconstruction.
