---
date: 2026-06-09
pr: 1438
commit: pending
feature: API file content block path context
impact: Adds the local file path to API file content block text so non-image attachments can be read by models and tools that need the uploaded file location.
---

API file content blocks now include a local file path line when the uploaded
file has a display name. Image content block conversion remains unchanged.
