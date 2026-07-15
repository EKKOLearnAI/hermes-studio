---
date: 2026-07-13
pr: 11
feature: Workflow orchestration evidence, portability, and recursive scheduling hardening
impact: Workflow execution, rerun, history, import/export, and live status now share one fail-closed persisted-evidence and capability contract.
---

# Workflow orchestration evidence, portability, and recursive scheduling hardening

- Fresh runs and reruns use the same completion-driven DAG and recursive laminar-loop schedulers over a normalized frozen graph.
- Reruns preserve append-only Node, Edge, and Loop history under a unique execution scope; preserved upstream inputs are accepted only when the latest source execution has matching persisted taken-edge evidence.
- Node executions record the exact Edge evidence IDs consumed by their prompt. Node, Edge, and Loop records share one monotonic Run sequence.
- HTTP Run detail, Run lists, WorkflowSocket live status, and client History use one hydrated persisted-evidence contract. Read failures return no partial history.
- Workflow import/export uses a versioned Agent-only definition allowlist, strips runtime state and credentials, validates exact model/API/tool capabilities in the target profile at preview and confirmation, binds one-shot preview tokens to owner/profile/environment revision, and creates a new Workflow without running it.
- Edge conditions use typed JSON operands, forbidden property paths fail during preflight, and explicit Feedback Edges have bounded stable Loop identities.
- Execution-policy and reasoning overrides fail closed when the target runtime cannot apply them; they are not treated as advisory UI metadata.

## Disposable live acceptance

Run `npm run test:workflow-live` for an isolated HTTP integration acceptance of the real Workflow routes, manager, scheduler, and SQLite stores. The harness:

- changes to a unique `mkdtempSync` root before dynamically importing any Workflow/store module;
- binds only a random `127.0.0.1` port and replaces only the Agent execution boundary with deterministic outputs;
- covers success/failure/always routing, true skipped nodes, default/custom/nested loops, rerun scopes, static budget rejection, absolute timeout, cancellation/late completion, restart recovery, and Run evidence deletion;
- deletes all disposable Workflows/Runs and removes the temporary SQLite root on both success and process exit;
- opens the production Web UI database read-only and requires the Workflow-specific table count/hash snapshot to remain identical before and after the run;
- writes its machine-readable result to `/tmp/hermes-studio-workflow-live-evidence.json` (override with `WORKFLOW_LIVE_EVIDENCE`).

The harness never starts the production server, never connects to Agent Bridge, and never invokes an existing Workflow.
