---
date: 2026-08-18
pr: 2601
feature: Bridge pre-persisted user-message deduplication
impact: After a bridge user-message write succeeds, native persistence skips exactly the matching user entry once, falls back to native persistence when the pre-persist write fails, and clears stale pending state after the run.
---
