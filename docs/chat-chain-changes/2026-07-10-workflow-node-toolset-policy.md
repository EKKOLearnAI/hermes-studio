---
date: 2026-07-10
pr: 2023
feature: Workflow node toolset policy
impact: Hermes-backed workflow nodes can restrict runtime toolsets per node while workflows without a policy retain the existing profile-level tool configuration.
---

# Workflow node toolset policy

Workflow snapshots propagate `executionPolicy.allowedToolsets` and the optional
exact `executionPolicy.allowedTools` whitelist through chat-run and both Agent
Bridge request paths before an `AIAgent` is created. The bridge first resolves
the allowed toolsets, then intersects the assembled Agent tool surface with the
exact whitelist and freezes MCP refresh for that session so later connections
cannot widen it. Policies can also set `skipMemory` and `skipContextFiles` to
prevent persistent-memory activity and cwd/SOUL context injection. An explicit empty allowlist remains a zero-tool policy, and
sessions are not reused across different policies.

The initial enforcement applies only to Hermes-backed nodes. Workflow nodes
using scoped Codex or Claude runtimes fail closed when configured with this
policy rather than silently running without enforcement.

Final context accounting now carries the same policy through both successful
and failed run finalization. A restricted session therefore cannot be recreated
with profile-default tools merely because post-run context usage is refreshed.
