---
date: 2026-07-13
pr: pending
feature: Ekko Agent tool-result asset sanitation
impact: Large base64 assets returned by tools are replaced with temporary file URLs before they enter the next model request.
---

Ekko Agent now sanitizes every tool result at the runtime boundary. Data URLs
and recognized large base64 fields are materialized under the operating
system's temporary directory at `ekko-agent/tool-assets`, then replaced with a
compact `file://` URL in both the model-facing content and event data. Assets
are content-addressed, limited to 25 MiB, written with owner-only permissions,
and removed after a 24-hour TTL during later tool-result cleanup passes.
