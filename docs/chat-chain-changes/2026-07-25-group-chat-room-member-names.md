---
date: 2026-07-25
pr: 2212
feature: Per-room human member profiles
impact: Human display names and descriptions remain room-specific across reconnects, browser ports, and room switches.
---

Room creation now persists the creator's form-entered member profile before
the realtime join. Later joins treat the room member row as authoritative,
using the authenticated user ID to recover the same identity when a browser
client ID changes.

An explicit member-profile socket action lets a user repair or rename only
their current room profile. Ordinary joins no longer double as an implicit
rename operation, and agent identities remain unchanged.
