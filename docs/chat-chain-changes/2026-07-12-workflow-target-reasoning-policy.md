---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-target-reasoning-policy
impact: Workflow node target, reasoning, and Hermes execution policy now remain validated and scoped through dispatch and context refresh.
---

# Workflow target, reasoning, and execution policy

- Validates `provider` / `model` / `apiMode` as an atomic workflow-node target before run creation.
- Adds canonical per-node `reasoningEffort` authoring and forwards explicit overrides to Hermes, Codex, and Claude Code runs; default remains omitted.
- Adds Hermes-only workflow execution policy for exact toolsets/tools and memory/context-file skipping.
- Preserves empty allowlists as deny-all and rejects malformed or unsupported coding-agent policies before mutation.
- Carries policy through chat, context estimation, final context refresh, and Python bridge session identity so refresh or reuse cannot widen permissions.

## Verification

- Workflow runtime and client authoring tests.
- Agent Bridge TypeScript forwarding and Python enforcement probes.
- Final context refresh policy regression.
- Server/client typecheck, harness, and production build.
