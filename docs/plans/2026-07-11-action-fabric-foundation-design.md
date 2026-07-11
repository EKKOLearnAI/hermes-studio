# Action Fabric Foundation Design

**Date:** 2026-07-11

**Roadmap scope:** Phase 3 of the Personal Digital Twin and Universal Action Fabric design

**Status:** Approved

## Objective

Phase 3 establishes the security and durability boundary for all future side effects. Assistant Roles submit semantic action intents; they do not invoke provider-specific tools directly. Every intent passes through capability resolution, policy evaluation, durable workflow execution, verification, audit, and reliable publication back to the Personal Twin.

The first release includes only simulator adapters and reversible internal actions. Real MCP, browser, payment, Home Assistant, desktop, and Android execution remains disabled until later roadmap phases, but those executors must be able to implement the same stable contracts without replacing the Phase 3 kernel.

## Scope

Phase 3 delivers:

- A semantic Capability Registry.
- Enforced Assistant Role capability policies.
- A durable action-intent and workflow state machine.
- Executor registration and health reporting.
- Simulator and reversible internal executors.
- Verification, retry, compensation, and dead-letter behavior.
- Hash-chained append-only audit events.
- A transactional outbox for Personal Twin and UI events.
- Three-level emergency stop controls.
- Protected HTTP APIs, typed client state, and an Action Center UI.

Phase 3 does not deliver:

- Real MCP or browser writes.
- Payments, orders, messaging, or external device control.
- Home Assistant or Android execution.
- Credential provisioning or revocation implementations for external providers.
- Autonomous scheduling beyond accepting intents from existing server-owned triggers.

## Architecture Decision

Action Fabric uses a separate global SQLite database at:

```text
<HERMES_HOME>/personal/action-fabric.db
```

The Action Fabric database is separate from `twin.db` because workflow leases, retries, audit writes, and worker polling have different contention and retention characteristics from Personal Twin reads. Cross-database consistency uses a transactional Action Fabric outbox and idempotent Personal Twin consumers instead of pretending that two SQLite databases share one atomic transaction.

The kernel has five components:

1. **Capability Registry** owns semantic contracts independent of provider implementations.
2. **Policy Engine** enforces role capability scope, targets, risk, decision authority, spending limits, and emergency stop state.
3. **Durable Workflow Runtime** owns intent persistence, state transitions, leases, retries, idempotency, verification, and compensation.
4. **Executor Registry** binds semantic capabilities to healthy executors and environment stages.
5. **Audit and Outbox** records immutable evidence and reliably publishes state changes.

The initial worker runs in the Hermes Studio server process, but worker ownership is expressed through leases so it can later move to a background service without changing workflow semantics.

## Capability Registry

Every capability is a semantic contract with these fields:

- Stable capability ID, domain, and verb.
- Versioned input and output JSON schemas.
- Side-effect and risk classification.
- Authentication requirements without secret values.
- Target restrictions.
- Idempotency support.
- Reversibility and compensation capability.
- Verification strategy.
- Cost and spending metadata.
- Availability and health.

Executors declare which contract versions they implement. Executor preference is policy-controlled and initially supports only `simulator` and `internal`. Later MCP and browser executors register against the same contracts and trigger a fresh policy evaluation whenever executor risk differs.

Initial capabilities are:

- `simulator.echo`
- `simulator.counter.increment`
- `internal.twin.preference.set`
- The semantic verification and compensation actions required by those capabilities

`internal.twin.preference.set` must capture the prior preference value before execution and compensate by restoring it or removing the newly created preference.

## Persistent Model

The database contains:

- `fabric_meta`: schema and kernel metadata.
- `fabric_capabilities`: semantic capability contracts.
- `fabric_executors`: executor identity, type, node, environment, health, and enabled state.
- `fabric_executor_capabilities`: versioned capability bindings.
- `fabric_action_intents`: structured requests, role, goal, target, constraints, rationale, and idempotency key.
- `fabric_workflows`: durable workflow state, policy snapshot, lease, retry, and scheduling fields.
- `fabric_steps`: ordered prepare, execute, verify, and compensate steps with bounded evidence.
- `fabric_policy_decisions`: allow, deny, or waiting-user decisions with stable reason codes and sanitized inputs.
- `fabric_budget_ledger`: reserved and committed per-action and daily amounts.
- `fabric_audit_events`: append-only events with previous and current hashes.
- `fabric_outbox`: reliable publications to the Personal Twin and UI.
- `fabric_control_state`: emergency-stop level, version, actor, and timestamp.

Schemas use explicit migrations, foreign keys, uniqueness constraints, and bounded JSON payloads. Secrets, raw credentials, browser sessions, and unredacted provider errors are forbidden in workflow, audit, and outbox payloads.

## Intent and Workflow Flow

The fixed execution flow is:

```text
Intent
  -> capability and executor resolution
  -> policy check
  -> durable workflow creation
  -> prepare
  -> execute
  -> verify
  -> audit
  -> transactional outbox
  -> idempotent Personal Twin projection
```

The workflow state machine supports:

```text
Draft -> PolicyCheck -> Preparing -> Executing -> Verifying -> Succeeded
                    \-> WaitingUser --------------------/
                                      \-> Retrying -> Executing
                          Verifying -> Compensating -> Failed
```

Terminal denial, cancellation, dead-letter, and compensated outcomes are represented explicitly. State transitions are server-owned and validated; callers cannot write arbitrary states.

## Policy Engine

Policy is default-deny. Execution requires all of the following:

- The Assistant Role exists and is enabled.
- The capability is explicitly allowed and not denied by the role.
- The capability, executor, and target are enabled and healthy.
- The executor environment is permitted for the capability rollout stage.
- Role decision authority covers the capability risk level.
- Per-action and cumulative daily spending limits remain available.
- Emergency-stop state permits creation and execution.
- Required user verification is satisfied.

The engine returns a stable decision object with `allow`, `deny`, or `waiting_user`, reason codes, rule versions, a sanitized input digest, and any budget reservation. Material changes to price, target, recipient, executor, or other protected inputs invalidate the decision and require evaluation again.

High-risk, irreversible, inadequately verified, or materially changed intents enter `WaitingUser`. Phase 3 simulator and internal capabilities remain non-financial and reversible, but the higher-risk paths are tested as policy fixtures.

## Durability, Retry, and Recovery

Workers acquire short leases using compare-and-update transactions. A process restart may claim only expired leases. Every step is persisted before execution and completed only after its evidence and outcome are durably stored.

Rules include:

- Intent idempotency keys are unique within their defined scope.
- Step execution tokens prevent duplicate commits.
- Temporary failures use bounded exponential backoff with deterministic retry scheduling.
- Permanent failures move to dead-letter state.
- Unknown execution outcomes never retry blindly; they enter `WaitingUser` until verification resolves the state.
- Circuit-breaker state disables unhealthy executors and forces fresh policy resolution.
- Compensation is a separate durable, policy-checked, audited action intent.

## Audit and Evidence

Each audit event records:

- Intent, workflow, step, user, role, and executor identifiers.
- Trigger and sanitized rationale.
- Capability and policy versions.
- State transition and stable reason code.
- Budget reservation and commitment metadata.
- Sanitized evidence references and result digests.
- Retry, takeover, cancellation, and compensation history.
- Timestamp, node identity, previous hash, and current hash.

The hash chain covers canonical event serialization. Ordinary APIs cannot update or delete audit events. Audit verification detects missing, reordered, or modified events.

## Emergency Stop

Emergency stop has three levels:

1. **Pause new actions:** reject new intents while leaving active work unchanged.
2. **Stop interruptible work:** also cancel or pause workflows whose executor declares safe interruption.
3. **Disable external writes:** also disable all external-write executors and call a future credential-revocation hook.

Control changes require super-admin authorization, create audit events, increment a control version, and invalidate stale policy decisions. The Phase 3 executor registry implements the revocation interface even though real provider credential revocation arrives later.

## HTTP API and Client Surfaces

Protected routes under `/api/hermes/action-fabric` expose:

- Capability and executor discovery.
- Intent creation and detail.
- Workflow listing, detail, approval, rejection, retry, cancellation, and compensation.
- Audit lookup and chain verification.
- Emergency-stop state and mutation.

Read operations require authentication. Intent creation and every state-changing operation require super-admin authorization. Bodies use explicit parsers and stable error codes. Responses never expose database paths, secrets, raw connector errors, or unbounded evidence.

Personal OS gains:

- **Action Center:** running, waiting, failed, recoverable, reversible, and completed workflows.
- **Capabilities and Authorization:** capability contracts, executor health, rollout environment, role grants, and risk.
- **Emergency Stop:** current level, effect summary, and privileged controls.

The UI reads server-authoritative state after mutations and handles out-of-order responses without showing evidence for the wrong workflow.

## Simulator and Reversible Internal Actions

Simulator executors are deterministic and support injected outcomes for tests: success, temporary failure, permanent failure, unknown result, verification mismatch, and compensation failure.

The internal Twin preference executor:

- Accepts a validated preference key and JSON-safe value.
- Captures the prior state during preparation.
- Writes through the Personal Twin store during execution.
- Verifies the canonical stored value.
- Emits an outbox event and audit evidence.
- Compensates by restoring the captured prior state.

Neither executor may bypass capability resolution, policy evaluation, workflow persistence, verification, or audit.

## Error Handling

- Invalid contracts or bodies return stable validation errors.
- Policy denials return stable reason codes without leaking rule internals that contain sensitive values.
- Temporary executor failures are retried within configured bounds.
- Repeated executor failures open a circuit breaker.
- Verification mismatches prevent success and require retry, compensation, or takeover.
- Unknown outcomes enter `WaitingUser` and prohibit automatic resubmission.
- Failed compensation produces a manual-resolution workflow state.
- Missing external systems do not degrade Personal Twin reads.

## Testing Strategy

Required tests include:

- Schema creation, sequential migration, constraints, and future-version rejection.
- Capability and executor contract validation.
- Role allow/deny, target, risk, decision authority, spending, and emergency-stop boundaries.
- Workflow state-transition legality.
- Lease ownership, expiry, crash recovery, and concurrent claims.
- Idempotent intent and step execution.
- Retry backoff, circuit breaker, dead-letter, and unknown-result behavior.
- Verification and compensation paths.
- Hash-chain creation and tamper detection.
- Audit and error redaction.
- Simulator fixture contracts.
- Reversible Personal Twin preference execution and compensation.
- API authentication and super-admin mutation guards.
- Client concurrency and complete Action Center workflows.
- Restart recovery from the last durably verified state.
- Full repository regressions, type checks, harness, and generated OpenAPI/MCP discovery.

## Acceptance Criteria

Phase 3 is complete when:

- A permitted simulator intent executes through registry, policy, durable workflow, verification, audit, and outbox.
- A denied role capability cannot reach an executor.
- Duplicate idempotency keys cannot produce duplicate execution.
- A workflow resumes after process restart without repeating a verified step.
- Unknown outcomes cannot trigger blind retry.
- A reversible internal preference action can execute, verify, and compensate.
- Per-action and daily limits are enforced transactionally.
- Emergency-stop levels prevent the documented classes of work.
- Audit-chain verification detects tampering.
- Action Center and capability surfaces reflect authoritative server state.
- External MCP/browser/payment/device writes remain unavailable.
- A later executor can register against the stable interface without changing intent, policy, workflow, or audit contracts.

