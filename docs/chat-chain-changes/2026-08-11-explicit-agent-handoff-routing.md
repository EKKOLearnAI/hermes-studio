---
date: 2026-08-11
pr: 2495
feature: explicit Group Chat Agent handoff routing
impact: Agent explanations may mention participant names without launching another run; only a final explicit handoff line is upgraded to structured routing metadata.
---

Group Chat Agent replies now distinguish conversational `@Participant` references from routing intent. The Agent adapter emits authoritative `mentions: []` for replies without a final handoff line, so visible explanatory references remain ordinary persisted text and never fall back to legacy name parsing. A final non-empty line beginning with `@Participant` remains an explicit handoff and is converted to validated structured participant metadata.

The server treats explicit empty metadata as a valid no-target decision, skips the routing entry point, and applies owner-only `@all` authorization only when metadata actually requests a broadcast. Omitted metadata keeps the existing fail-closed compatibility behavior for Agent-authored visible mentions. Non-empty metadata continues to enforce Room membership, stable participant identity, display-name consistency, sender exclusion, duplicate rejection, and broadcast policy.
