---
date: 2026-07-29
pr: 2226
feature: Structured Group Chat mentions
impact: Human clients bind selected mentions to stable Room participant identities, while typed or pasted mention text omits empty metadata so unique legacy names still route and invalid structured targets fail closed.
---

- The input keeps selected Mention entities separate from display text and sends `participantId` metadata with the Socket.IO message.
- Hand-typed or pasted `@name` text carries no structured metadata, so the server keeps the bounded unique-name text fallback instead of silently dropping the request.
- The server validates participant IDs against the current Room, persists nullable mention metadata atomically with the message and handoff jobs, and includes it in replay identity.
- Existing clients and trusted runtime messages that omit mention metadata continue through the Unicode-aware text parser fallback.
- Legacy Mention routing and target-window selection parse only user-authored string/text blocks; attachment names, paths, and display metadata remain part of model/token input but can never select, add, or replace Agent targets.
- REST and realtime join responses use the same public participant serializer, preserving each participant avatar while excluding internal session/checkpoint fields.
