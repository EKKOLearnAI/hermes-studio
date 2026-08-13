---
date: 2026-08-10
pr: pending
feature: Group Agent Relay mentions and pending interactions
impact: Remote Agent handoffs preserve multi-Agent mentions, approval and clarification lifecycles stay routable across Relay, and expired interactions are removed from the group chat UI.
---

Relay message events now retain bounded structured mention metadata and the cloud
proxy also rebuilds mentions from authoritative room state. Approval and
clarification events use cloud-scoped IDs, support responses back to the remote
runtime, and extend the Relay run timeout while waiting for the user.

Pending approvals and clarifications have bounded server-side expiry. A Relay
timeout, disconnect, or already-expired runtime request removes the pending
route and emits a terminal event so browsers do not retain an unusable action.
Invalid Relay events now fail the active run immediately instead of poisoning
the sequence and surfacing a misleading error on the next event.

Streaming reasoning in Group Chat remains available behind its disclosure but
is collapsed by default to prevent concurrent Agent output from flooding the
message list. The Group Chat client now batches token and reasoning deltas into
50 ms render updates, keeps ordinary message objects stable, and limits live
body Markdown rendering to 100 ms intervals. Stream completion still flushes
immediately, while disconnects and room switches discard stale buffered data.
