---
date: 2026-09-05
pr: pending
feature: Mobile calendar and reminder consent duration
impact: Default to five minutes like the App generic consent card, with matching server and device deadlines instead of a 30-second device cap.
---

MCP and OpenAPI allow 3–300 seconds and advertise a five-minute default.
Explicit shorter waits remain supported. Expired delete protection remains;
location and other Agent-specific approval timeouts are unchanged. Current App
already consumes timeout_ms/expires_at_ms so no App/native rebuild is required.
