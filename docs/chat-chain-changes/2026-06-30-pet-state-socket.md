---
date: 2026-06-30
pr: pending
feature: Pet state socket
impact: Chat-run lifecycle, reasoning, tool, approval, clarify, completion, and failure events are mirrored into a profile-scoped pet-state socket without changing chat execution, queueing, persistence, resume, or message payload behavior.
---

The new `/pet-state` Socket.IO namespace exposes a read-only, profile-scoped activity snapshot for desktop pet consumers. Existing chat-run events remain the source of truth; the pet-state layer derives mascot activity from those events and broadcasts snapshots to subscribers.
