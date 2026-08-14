---
date: 2026-08-13
pr: 2536
feature: Group Chat Agent run Tool ownership
impact: Persisted Tool traces remain inside their owning Agent run card after the transcript across live, terminal, and refreshed history states.
---

Agent run grouping now prefers the durable room-Agent record identity over
transport sender identities. Tool rows remain newest-first in one bounded panel
after the owning run transcript and before its timestamp.
