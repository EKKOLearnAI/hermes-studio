---
date: 2026-07-29
pr: 2226
feature: Structured Group Chat mentions
impact: Human clients bind selected mentions to stable Room participant identities, while absent metadata keeps legacy text parsing and invalid structured targets fail closed.
---

- The input keeps selected Mention entities separate from display text and sends `participantId` metadata with the Socket.IO message.
- Hand-typed or pasted `@name` text from the updated client carries an explicit empty mention list and does not trigger a participant accidentally.
- The server validates participant IDs against the current Room, persists nullable mention metadata atomically with the message and handoff jobs, and includes it in replay identity.
- Existing clients and trusted runtime messages that omit mention metadata continue through the Unicode-aware text parser fallback.
