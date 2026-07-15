---
date: 2026-07-06
commit: pending
feature: Group chat room workspace binding
impact: Group chat rooms can store a validated workspace path, redact it for invite/read-only access, keep management/approval controls limited to room managers, and pass the workspace into room agent bridge runs. This affects room create/clone/detail/list/update flows and agent bridge run options, but does not add workspace-diff message persistence or workspace run lifecycle handling.
---

This split PR adds the room-level workspace setting and management/access fencing needed before workspace-diff execution can be layered on top. Room agents receive the room workspace in bridge run options when configured; invite-code and read-only views do not expose the path or approval command payloads.
