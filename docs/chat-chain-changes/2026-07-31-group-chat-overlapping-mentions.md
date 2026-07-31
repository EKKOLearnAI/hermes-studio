---
date: 2026-07-31
pr: 2226
feature: Group Chat overlapping participant Mention routing
impact: Typed or pasted Mention fallback selects only the longest valid participant name at one @ position, while independent Mention tokens elsewhere in the message still route independently.
---

- When Room participant names overlap at the same `@` position, such as `Hermes` and `Hermes-B`, `@Hermes-B` schedules only `Hermes-B` instead of both participants.
- Longest-name disambiguation happens before sender exclusion, so an Agent mentioning its own longer name cannot accidentally route the shorter overlapping participant.
- A message containing independent `@Hermes` and `@Hermes-B` tokens still targets both participants.
- The reserved `@all` token participates in the same longest-range disambiguation, so a participant such as `all-B` receives `@all-B` without accidentally broadcasting to the Room.
- The production handoff planner consumes that same resolved route and broadcast flag in both `mentions` and `fixed` modes; it does not short-circuit on the raw `@all` prefix.
- Runtime prompts and Coding Agent envelopes use the durable handoff kind selected by the planner instead of re-inferring fan-out from message text.
- Mention-token stripping also keeps only the longest range at one `@` position, preventing overlapping `@all` / `@all-B` removal from corrupting the model input.
- Structured Mention routing remains ID-authoritative and unchanged.
- The Composer now omits structured metadata before emitting a message when the user only typed or pasted Mention-shaped text; picker-backed entities remain stable-ID metadata.
- Realtime clients declare Mention protocol version `1`. After an in-place server/package upgrade, a stale already-open tab that still sends structured metadata under the older protocol is rejected atomically with `GROUP_CHAT_CLIENT_REFRESH_REQUIRED` instead of persisting `mentions: []`; legacy clients that omit the metadata field keep the bounded text-fallback path.
- Installed-runtime forensics showed the failed package's on-disk client/server bytes matched the candidate, while the retained failed Room stored `mentionsJson='[]'` for ordinary text and the historical pre-fix client always emitted that field. The persisted behavior is therefore consistent with an older already-loaded client protocol, not an on-disk client/server dist mismatch; the browser cache state at send time was not directly captured.
