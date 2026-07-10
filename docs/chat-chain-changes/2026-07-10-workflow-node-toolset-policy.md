---
date: 2026-07-10
pr: 2023
feature: Workflow node toolset policy
impact: Hermes-backed workflow nodes can restrict runtime toolsets per node while workflows without a policy retain the existing profile-level tool configuration.
---

# Workflow node toolset policy

Workflow snapshots propagate `executionPolicy.allowedToolsets` through chat-run
and both Agent Bridge request paths before an `AIAgent` is created. An explicit
empty allowlist remains a zero-tool policy, and sessions are not reused across
different policies.

The initial enforcement applies only to Hermes-backed nodes. Workflow nodes
using scoped Codex or Claude runtimes fail closed when configured with this
policy rather than silently running without enforcement.
