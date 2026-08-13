---
date: 2026-08-11
pr: 2495
feature: Group Chat Agent mention deduplication
impact: Mentions route regardless of position, while repeated mentions of one participant in the same Agent reply dispatch that participant only once.
---

Group Chat Agent replies scan the complete visible message for Room participant mentions without restricting them to a line or position. The Agent adapter emits at most one structured target per participant, so repeated `@AA` references dispatch AA once while a message containing both `@AA` and `@AB` dispatches both once.

The server treats explicit empty metadata as a valid no-target decision, skips the routing entry point, and applies owner-only `@all` authorization only when metadata actually requests a broadcast. Omitted metadata keeps the existing fail-closed compatibility behavior for Agent-authored visible mentions. Non-empty metadata continues to enforce Room membership, stable participant identity, display-name consistency, sender exclusion, duplicate rejection, and broadcast policy.
