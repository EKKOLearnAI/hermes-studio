---
date: 2026-07-28
pr: 2226
feature: Authorized durable mixed-runtime Group Chat handoffs
impact: Group Chat handoffs now persist actor, capability, Room revision, stable participant session, and lease provenance; claim, launch, runtime events, final messages, workspace evidence, cancellation, and recovery fail closed when authority or durable ownership changes. Every Agent publication from a canonical participant session with a running durable handoff—including command-role messages and workspace evidence—must carry the matching live job and lease provenance, bound to the same Room, before any message, room, or workspace mutation; terminal ACK replay requires the same persisted payload, Room, immutable final/non-final state, and a matching one-way lease proof, emits no duplicate room events, while stale replay cannot bypass a newer running owner.
---
