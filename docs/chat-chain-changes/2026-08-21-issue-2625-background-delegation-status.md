---
date: 2026-08-21
pr: 2629
feature: issue-2625-background-delegation-status
impact: A chat and its session-list entry report outstanding background delegate_task work after the foreground turn completes, including after a session resume, without treating that work as foreground streaming.
---

# Issue #2625

The client keeps a per-session count of running background delegations from the resume payload and subsequent run events. The count keeps an otherwise idle session visibly active, appears in the selected chat as a calm status, and appears beside background sessions in the list.

Foreground streaming and cancellation behavior are unchanged. The count is cleared only when the server reports no outstanding background work.
