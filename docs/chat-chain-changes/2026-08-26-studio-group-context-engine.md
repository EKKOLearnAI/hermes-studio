---
date: 2026-08-26
feature: studio-group-context-engine-ownership
impact: Group chat context compression, gateway bridging, and summary caching are now owned by the Studio module; existing Hermes import paths remain compatibility facades and runtime behavior is unchanged.
pr: pending
---

# Studio group context engine ownership

The group chat context engine moved from the legacy Hermes service tree to
`modules/studio/services/group-chat/context-engine`. The gateway continues to
use the same primary-agent bridge through the injected Studio runtime contract,
and compression thresholds, summary cache keys, prompts, and fallback behavior
are unchanged. Legacy imports re-export the Studio implementation so existing
callers remain compatible during the modularization.
