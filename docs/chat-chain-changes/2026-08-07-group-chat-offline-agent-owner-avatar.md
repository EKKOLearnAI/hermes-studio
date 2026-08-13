---
date: 2026-08-07
pr: pending
feature: Preserve offline group Agent owner avatars
impact: Room Agents keep their inviter avatar badge when that room member is offline, while offline Agents remain visible with an offline connection status.
---

Realtime join and member-update payloads now use persisted room membership as
their canonical public member view. A member going offline does not remove
their room identity or avatar, so other clients can continue resolving the
owner badge for Agents that member invited.

The in-memory member view remains a fallback when persistent storage is
unavailable. Explicitly removing a room member still deletes that membership,
and explicitly removing an Agent still removes it from the Agent roster.
