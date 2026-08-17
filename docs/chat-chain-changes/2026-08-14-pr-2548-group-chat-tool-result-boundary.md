---
date: 2026-08-14
pr: 2548
feature: Bounded Group Chat tool-result delivery
impact: Group Chat history and live updates now bound ordinary outbound tool results to 1,000 characters while preserving complete persisted and Agent-context data.
---

Group Chat previously bounded UI history by message count only, so a page or
room-join response could still contain large Tool result bodies. Historical
pages and live message broadcasts now reuse the same display-only truncation
boundary as single-chat resume, including truncation metadata for clients.

The boundary is applied only when messages leave the server. Stored messages
and the transcript supplied to Agents retain their complete content.
`workspace_diff` messages remain complete because clients use their structured
payloads to render file changes.
