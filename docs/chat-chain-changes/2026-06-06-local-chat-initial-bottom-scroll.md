---
date: 2026-06-06
pr: pending
feature: Chat initial bottom scroll
impact: First session entry keeps bottom-follow active until the initial message load and virtual list measurement settle.
---

Fixes a race where the chat page could scroll before resumed messages and
virtualized row heights were fully rendered, leaving the first view slightly
above the newest message.

When messages are already present and the session is not in a loading state,
the initial-scroll pending gate is released after scheduling the bottom scroll
so later streaming updates can still run their normal auto-follow checks.
