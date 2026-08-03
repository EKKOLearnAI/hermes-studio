---
date: 2026-08-02
pr: 2226
commit: pending
feature: Group Chat durable authority, lifecycle recovery, and Activity Dock
impact: Separates next-run participant configuration from live authority, freezes the admitted runtime tuple, scopes managed MCP side effects to a signed Room/job/session/Profile capability, verifies complete Coding Agent process-tree termination and crash recovery before terminalization, preserves workspace evidence durably, and replaces duplicate reply/handoff banners with one accessible Activity Dock.
---

> **Refactor handoff note (2026-08-03):** this fragment records the intended contract, not a verified mergeable implementation. Exact-head adversarial review later proved that POSIX containment can be escaped, activation persistence failure can leave a live process, workspace evidence failure can still publish success, and managed MCP caller identity/lifetime remain unsafe. See `docs/group-chat-mixed-runtime-refactor-handoff.md`; do not use this fragment as completion evidence.

- Durable handoffs retain immutable participant runtime snapshots while Profile assignment, Room actor, Session generation, job lease, and exact MCP tool authority are revalidated live and fail closed.
- Bridge workers and Group Chat Coding Agents receive only run-scoped managed MCP capabilities; the final MCP dispatcher validates the exact server/tool before side effects.
- Coding Agent ownership survives server crashes, verifies the full process tree is gone, captures durable workspace evidence, and only then publishes terminal state or deletes session artifacts.
- Approval retry, FIFO busy-message delivery, shutdown quiescence, API mode cache identity, and participant Profile reassignment fences are aligned across the Room runtime.
- The client presents one compact Activity Dock with explicit stop-current-reply versus stop-entire-handoff semantics, terminal/stale cleanup, keyboard support, and localized labels.
