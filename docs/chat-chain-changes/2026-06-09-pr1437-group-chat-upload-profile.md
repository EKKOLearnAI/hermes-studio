---
date: 2026-06-09
pr: 1437
commit: pending
feature: Group chat attachment upload profile routing
impact: Sends the active Hermes profile with group chat attachment uploads so files are stored under the same profile used by the room message.
---

Group chat attachment uploads now include the active profile header alongside
the existing auth header. Multipart FormData content-type handling is unchanged.
