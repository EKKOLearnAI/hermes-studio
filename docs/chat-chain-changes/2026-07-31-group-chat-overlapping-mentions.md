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
