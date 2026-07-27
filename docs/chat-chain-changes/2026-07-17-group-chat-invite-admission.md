---
date: 2026-07-17
pr: 1
feature: Group Chat v2 invite admission atomicity and non-enumerating room access
impact: Group chat invite joins now recheck room state inside one transaction, rotate invite generations with room authorization revisions, and hide private room existence from strangers on join/detail access paths.
---

- Invite admission now persists membership and actor state only after a transactional room reload confirms the current invite or an already-authorized subject.
- Invite rotation increments both `inviteGeneration` and `authorizationRevision` in the central `gc_rooms` schema path.
- Stranger room detail, Socket.IO join, and invalid invite lookups now reuse the same missing-room shape instead of exposing private room existence.
- Automatically generated invite codes now use a 32-character unambiguous alphabet with 16 symbols (80 bits) from OS-backed cryptographic randomness in both server and browser paths; explicit user-supplied codes remain exact-byte, case-sensitive secrets.
- REST and Socket.IO invite failures share one bounded per-subject limiter. Limited attempts keep the same missing-room response and limiter keys never contain the invite secret.
- Invite-code lookup compares every persisted candidate through the same domain-separated constant-time digest path instead of using a valid-vs-invalid SQL equality branch.
