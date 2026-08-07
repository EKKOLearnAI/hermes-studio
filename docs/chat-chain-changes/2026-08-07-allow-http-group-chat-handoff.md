---
date: 2026-08-07
pr: pending
feature: Allow HTTP group chat Agent handoff
impact: Remote Agent handoff can connect to a public group chat origin over either HTTP or HTTPS.
---

Cloud-origin validation now accepts remote HTTP origins for Agent handoff,
outbound Relay connection, and persisted Relay restoration. URL credentials,
paths, queries, fragments, and non-HTTP protocols remain rejected.

HTTP does not protect handoff tickets, request secrets, Relay credentials, or
room traffic from network interception. Deployments that require transport
confidentiality must continue to use HTTPS.
