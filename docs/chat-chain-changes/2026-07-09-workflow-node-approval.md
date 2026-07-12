---
date: 2026-07-09
pr: pending
feature: Workflow node approval
impact: Workflow runs can pause after a node completes until the user approves or rejects that node in the node chat panel.
---

Workflow node definitions now persist an `approvalRequired` flag in node JSON.
Missing flags default to `false`, so existing workflow definitions keep running
without a node-level approval gate.

Workflow manager still passes `approvalChoice: 'once'` to chat runs so existing
tool-call approval behavior is unchanged. Node approval happens after a node chat
run succeeds: the manager marks that node `pending_approval` and waits for the
workflow node approval API response. Approval releases downstream nodes.
Rejection marks only that node `approval_rejected`; other pending node approvals
remain pending, and not-yet-executed downstream nodes are canceled only after the
active approval batch has resolved.
