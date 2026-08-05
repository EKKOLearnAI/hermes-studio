---
date: 2026-08-05
pr: 2359
feature: Structured group mentions and server activity time
impact: Group-chat routing now accepts only validated structured agent IDs, and room activity ordering ignores sender-provided timestamps.
---

Client-created mentions carry stable agent IDs and are revalidated by the server
before routing; display names do not select route targets. Group-room ordering
uses server persistence time rather than sender-provided message timestamps.
