---
date: 2026-08-21
pr: 2648
feature: Unified Runtime-authoritative Studio approvals
impact: Direct and group chat use one Studio approval card for Hermes, Ekko, Claude Code, Codex, and Pi while preserving each Runtime's supported choices and ownership.
---

Bridge and Socket.IO approval resolution events now preserve `resolved`, expiry,
staleness, and error details end to end. Duplicate clicks are blocked while a
response is pending, mismatched approval IDs cannot close another card, and an
expired approval explicitly states that its command will not execute.

Managed Coding Agent runs now use structured Runtime adapters instead of
interactive text or bypass flags:

- Claude Code runs in manual permission mode and sends `PermissionRequest`
  HTTP hooks to a per-run bearer capability.
- Codex runs through `app-server` JSON-RPC and maps native command/file-change
  approval requests and `serverRequest/resolved` notifications.
- Pi guards controlled tool calls with its RPC `confirm` UI request; read-only
  tools remain non-interactive.
- Ekko keeps its structured tool approval service and now identifies its
  Runtime and run generation on the shared protocol.

Every pending approval is fenced by its actual Runtime, chat/room session,
participant Agent, run generation, and approval ID. Responses return only to
the owning Runtime session. Starting a new generation, stopping/replacing an
Agent, clearing/deleting a Room, expiry, or Runtime teardown denies and marks
older requests stale. Ordinary chat messages such as “allow” are never parsed
as authorization. Unsupported Claude Code or Codex structured approval
interfaces fail before a managed run starts; Studio does not fall back to
permission bypass flags or PTY text parsing.

The card now identifies the Agent, risk description, command/target, and only
the choices supported by that Runtime. Workflow approvals are unchanged and
remain outside this change.

Closes #2558.
