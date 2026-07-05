---
date: 2026-07-05
pr: pending
feature: Group Chat workspace diff audit messages
impact: Group Chat rooms can persist a validated workspace, workspace-tracked agent runs reserve a Bridge run id before worker start, and bounded workspace diff audit messages stay visible in history while excluded from future model context.
---

Group Chat workspace runs now supply a 32-lowercase-hex Bridge `run_id` and
start the workspace diff checkpoint before `bridge.chat()`. Terminal run states
persist a bounded `workspace_diff` tool message and the workspace run change in
one database transaction.

The persisted diff card renders from the bounded group message payload. No
group-chat lazy workspace diff file-detail endpoint is added.
