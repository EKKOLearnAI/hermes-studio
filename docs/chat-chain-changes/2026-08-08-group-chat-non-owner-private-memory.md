---
date: 2026-08-08
commit: pending
feature: Non-owner Group Chat private-memory boundary
impact: A participant who does not own the target Agent can use relevant room-shared and professional task knowledge but cannot retrieve or learn the Agent's private personal memories.
---

The per-turn non-owner Group Chat security context now treats private memory as
a separate protected category. It forbids searching for, quoting, summarizing,
enumerating, confirming the existence of, or indirectly revealing private
memories about the Agent, its owner, or other participants.

Protected memory includes personal preferences, habits, routines,
relationships, health and financial information, private or precise locations,
identity details, private communications and history, and behavioral profiles
and inferences. Personal privacy remains protected regardless of the room or
session in which the Agent learned it. Ambiguous memory defaults to private.

Professional-skill memory remains available across rooms regardless of its
source room, including generalizable methods, technical knowledge, reusable
workflows, domain expertise, and non-personal task lessons. Before sharing that
knowledge, the Agent must remove embedded personal or private details and must
not reveal private memory records or provenance. Cross-room professional memory
does not override the existing credential, sensitive-data, or workspace
restrictions. Owner-issued turns continue to use the normal Group Chat prompt.
