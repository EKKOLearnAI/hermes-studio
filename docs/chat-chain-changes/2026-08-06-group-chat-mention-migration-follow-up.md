---
date: 2026-08-06
pr: 2370
feature: Group-chat mention fail-closed follow-up and stable activity migration
impact: Agent broadcasts and verified handoffs route through the structured protocol, while legacy activity timestamps remain stable across restarts.
---

Agent `@all` replies now use the same validated entry DTO as direct handoffs.
The server verifies the complete visible Agent mention set before persistence:
missing, empty, mismatched, cross-room, stale, duplicate, self-directed, and
malformed broadcast metadata are atomically rejected. Persisted DTOs continue to
contain routing identities only, and dispatch resolves those identities before
calling the target Agent.

Legacy activity migration records its first cutoff transactionally. Values that
were future or otherwise untrusted during that first upgrade remain untrusted on
later initialization. Administrator, Profile, authenticated-member, owner, and
aggregated REST room lists share one activity-time rule: tool and streaming
messages do not promote room activity.
