---
date: 2026-08-17
pr: 2594
feature: Group Chat history in the live room
impact: The live Group Chat loads older messages by stable cursor until the first retained message, while legacy history URLs redirect to the room and the duplicate History surface is removed.
---

Issue #2593 removes the client-side Group Chat message cap without changing the
bounded context used for Agent prompts. The initial room load remains one page;
older pages are requested on demand, de-duplicated by message ID, and anchored
in the current transcript. Existing room authorization and retained SQLite
messages remain authoritative.
