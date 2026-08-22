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

- Claude Code runs in manual permission mode and delegates non-interactive
  permission prompts to an isolated MCP adapter backed by a per-run bearer
  capability.
- Codex runs through `app-server` JSON-RPC and maps native command/file-change
  approval requests and `serverRequest/resolved` notifications. Its app-server
  stream is the sole text projection source while the provider proxy remains
  responsible for transport and usage accounting.
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
the choices supported by that Runtime. Missing, empty, or invalid option lists
are normalized against the identified Runtime: Claude Code and Pi remain
limited to once/deny, Codex to once/session/deny, and unknown Runtimes use the
conservative once/deny fallback. Legal Runtime-provided subsets remain
authoritative rather than being expanded by the server or client stores.
Workflow approvals are unchanged and remain outside this change.

Closes #2558.
