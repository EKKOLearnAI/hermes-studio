---
date: 2026-08-22
pr: 2648
feature: Group Chat expired approval terminal cleanup
impact: Expired or stale Runtime approvals remain denied but are removed from Room and global pending-action surfaces, including reconnect snapshots.
---

Group Chat now treats `approval.resolved` events and response acknowledgements
marked `expired` or `stale` as terminal. The matching pending approval is removed
instead of remaining visible as an actionable card, while unrelated approval IDs
remain isolated.

When a non-Hermes Runtime generation no longer owns an approval, the server
removes the pending route and broadcasts the same structured expired/stale
terminal event to every authorized surface owned by that Room member. A refresh
therefore cannot restore the expired request, and the late response remains
rejected without executing its command.
