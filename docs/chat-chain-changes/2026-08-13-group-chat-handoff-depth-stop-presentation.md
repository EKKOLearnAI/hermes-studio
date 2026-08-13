---
date: 2026-08-13
pr: 2511
feature: Group Chat handoff depth-stop presentation
impact: Show actionable handoff stops only for trusted finite depth-limit events
---

## Summary

Group Chat now persists and presents an Agent handoff depth-stop only when a trusted structured Agent handoff reaches an enabled finite depth limit. Ordinary Agent replies, disabled handoff policy, unlimited handoffs, missing trusted metadata, and messages without a concrete Agent target do not create actionable stop records.

## Impact

- Prevents internal sentinel depths from appearing as user-facing handoff history.
- Prevents disabled handoffs from being mislabeled as maximum-depth stops.
- Keeps legitimate finite depth-limit stops attached to their source message with the existing one-time continuation action.
- Keeps stop history out of the Room settings form; the form remains configuration-only.

## Notes

Existing malformed rows remain non-presentable and are not mutated automatically. Cleaning persisted business Room records requires a separately authorized data migration or administrative action.
