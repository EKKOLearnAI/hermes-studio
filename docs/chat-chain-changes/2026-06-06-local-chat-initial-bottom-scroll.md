---
date: 2026-06-06
pr: pending
feature: Chat initial bottom scroll
impact: First session entry keeps bottom-follow active until the initial message load and virtual list measurement settle.
---

Fixes a race where the chat page could scroll before resumed messages and
virtualized row heights were fully rendered, leaving the first view slightly
above the newest message.
