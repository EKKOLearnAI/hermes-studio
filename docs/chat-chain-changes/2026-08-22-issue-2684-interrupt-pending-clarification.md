---
date: 2026-08-22
commit: pending
feature: Group Chat force-stop clarification lifecycle
impact: Force-stop now releases the exact pending clarification waiter and clears its Room/global pending UI without affecting other generations.
---

Group Chat binds clarification prompts to the active Session and run
generation. Force-stop claims only that generation's prompt, releases the
underlying Runtime waiter, emits a resolved event so pending UI clears, and
rejects late replies without affecting other generations, Sessions, Rooms, or
Agents. The existing exact Gateway approval waiter isolation remains unchanged.

The concentrated rework preserves the Session and visible run generation when
internal Agent activity is broadcast to Group Chat. This keeps the real
`interruptAgent` → `ChatRun.abortSession` path able to claim the matching
clarification even when the Runtime waiter is not owned by ChatRun's current
local abort controller.
