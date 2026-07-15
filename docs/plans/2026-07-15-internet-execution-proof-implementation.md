# Internet Execution Proof Implementation Plan

**Goal:** Implement Phase 6 as a governed MCP and persistent-browser execution proof using read-only Bilibili semantic capabilities.

**Architecture:** Action Fabric owns policy, workflow, recovery, verification, and audit. Hermes profile runtimes own MCP/browser transports and credentials. A global receipt store checkpoints only sanitized semantic execution state.

## Time-boxed Delivery

- Batch A — executor foundation: Tasks 1-3.
- Batch B — governed MCP proof: Tasks 4-7.
- Batch C — persistent browser recovery: Tasks 8-10.
- Batch D — product surface and closure: Tasks 11-15.

Each task starts with a failing focused test, implements the smallest contract, runs server TypeScript where relevant, and commits only its files.

### Task 1: First-Class Internet Executor Types

Upgrade Action Fabric persistence and contracts for `mcp` and `browser` executor types. Rebuild the constrained executor table safely, preserve foreign keys and rows, update runtime interruption/external-write classification, API schemas, and upgrade/reopen tests.

### Task 2: Internet Receipt Contracts And Store

Add `internet-execution` types, database, and store for workflow-bound receipts and browser checkpoints. Enforce canonical JSON, material digests, bounded payloads, legal stage transitions, replay identity, and credential-free persistence.

### Task 3: Internet Semantic Contracts

Define exact Bilibili search/inspect schemas, normalized output, target atoms, URL/BVID validation, response bounds, result semantics, and forbidden mutation/tool/browser surfaces.

### Task 4: Agent Bridge MCP Tool Calls

Add a server-internal `mcp_tool_call` bridge action using the existing profile MCP runtime. Enforce configured-server membership, registered/include-filtered tool identity, plain bounded arguments, timeout, sanitized result conversion, and Python/TypeScript bridge tests.

### Task 5: MCP Configuration And Discovery

Resolve profile-scoped semantic bindings for Bilibili without loading credentials. Discover exact tool availability, expose sanitized health, support conventional defaults plus bounded name overrides, and fail closed on ambiguity or missing tools.

### Task 6: Generic MCP Action Fabric Executor

Implement a reusable MCP adapter driven by server-owned semantic bindings. Persist prepare/execute/verify receipts, normalize results, make read replay safe, verify through a second read, and map transport uncertainty or malformed output to stable outcomes.

### Task 7: Bilibili MCP Production Lifecycle

Register Bilibili capabilities, the MCP executor and bindings; authorize the Entertainment Assistant for exact profile/provider/origin atoms; wire bootstrap health, revocation, emergency-stop behavior, and adapter lifecycle.

### Task 8: Agent Bridge Browser Calls

Add a server-internal browser bridge action restricted to navigate and snapshot. Bind task/session IDs to the workflow, validate public HTTPS destinations, preserve profile isolation, sanitize results, and reject click/type/evaluate/download primitives.

### Task 9: Persistent Browser Executor

Implement the browser adapter for Bilibili search/inspect with stable workflow task identity, safe URL construction, navigation/capture checkpoints, bounded accessibility parsing, challenge detection, and fresh-snapshot verification.

### Task 10: Restart, Replay, And Executor Change

Prove effect-before-checkpoint recovery, process/session loss recovery, idempotent read replay, MCP disconnect behavior, browser fallback selection, and mandatory fresh policy material when executor/environment changes.

### Task 11: Internet API And OpenAPI

Add thin authenticated controllers/routes for executor overview, Bilibili search/inspect intents, receipts, and workflow review. Validate exact server-derived profiles and targets, forbid raw tool/browser input, and regenerate deterministic strict OpenAPI.

### Task 12: Personal Twin Outcomes

Project verified video discoveries into bounded Entertainment entities/events/outbox records with provider identity and receipt provenance. Make repeated workflow replay idempotent.

### Task 13: Internet Execution Client Surface

Add typed API helpers, Pinia state, route, status/result/workflow panels, search/inspect forms, executor/fallback explanations, takeover state, explicit refresh, and credential/path-free rendering with all-locale messages.

### Task 14: Security And Compatibility Closure

Update Action Fabric/role UI language for external executors, harden audit redaction, preserve existing MCP management and browser chat behavior, document Agent Bridge impact, and add regression tests for injection, private URLs, secrets, and dangerous tools.

### Task 15: End-to-End Closure

Run fake MCP and browser flows for execute, restart replay, second-read verification, fallback re-policy, challenge takeover, credential revocation, emergency stop, and mutation rejection. Run focused suites, browser tests, harness, TypeScript, build, OpenAPI determinism, and final review.

