---
date: 2026-08-02
pr: pending
feature: Persistent bridge interactions
impact: WebUI clarify and approval prompts wait for an explicit response by default, while operators can restore a fail-closed deadline with one bridge environment variable.
---

`HERMES_AGENT_BRIDGE_INTERACTION_TIMEOUT_SECONDS` controls terminal approval,
clarify, and the WebUI-side gateway approval contract. Unset, `0`, and `none`
mean that the bridge does not expire the request; a positive integer publishes
the corresponding millisecond deadline and denies unanswered approvals when it
expires. Pending waits are cancelled when their run finishes or is interrupted,
their session is destroyed, or the bridge shuts down. Responses claim a request
once, so duplicate and late responses cannot execute an approved action twice.

Gateway approvals are ultimately owned by Hermes Agent's canonical approval
implementation. The bridge publishes an unlimited UI deadline and adds no local
timer by default, but an independently configured canonical Hermes timeout may
still deny a gateway approval earlier. This integration never converts a timeout,
cancellation, or missing response into approval and does not change Hermes
hardline or blocklist checks.
