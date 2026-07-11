# Action Fabric Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Phase 3 Action Fabric foundation with enforced role policies, durable workflows, simulator and reversible internal executors, audit, emergency stop, protected APIs, and an Action Center UI.

**Architecture:** Add an isolated SQLite-backed kernel at `<HERMES_HOME>/personal/action-fabric.db`. Semantic intents pass through registry resolution, enforced role policy, durable workflow steps, executor verification, hash-chained audit, and a transactional outbox. Phase 3 registers only simulator and reversible internal executors; later MCP/browser executors implement the same interfaces.

**Tech Stack:** TypeScript, Node `node:sqlite`, Koa, Pinia, Vue 3, Naive UI, Vitest, generated OpenAPI, Hermes MCP discovery hints.

---

## Execution Rules

- Use `@superpowers:test-driven-development` for every implementation task.
- Use `@superpowers:systematic-debugging` before changing code in response to any unexpected failure.
- Use `@superpowers:requesting-code-review` after Tasks 1–7, after Tasks 8–12, and after final verification.
- Preserve every pre-existing auth, Health, scale, router, sidebar, locale, and test worktree change. Do not stage unrelated files.
- Do not touch `packages/client/src/router/index.ts`, `packages/client/src/components/layout/AppSidebar.vue`, or global locale files. Mount the first Action Center as the third tab in the clean `ProfilesView.vue` administration surface.
- Never log or persist credentials, database paths, raw provider failures, browser sessions, or unbounded evidence.
- All execution paths, including tests and internal actions, must pass registry, policy, workflow, verification, and audit.
- Keep real MCP, browser, payment, Home Assistant, desktop, and Android writes unavailable in Phase 3.
- Use exact-path staging and inspect `git diff --cached` before every commit.

## Task 1: Action Fabric Types and Database Schema

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/types.ts`
- Create: `packages/server/src/services/hermes/action-fabric/database.ts`
- Create: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-database.test.ts`

### Step 1: Write failing database tests

Cover:

- Database path is `<HERMES_HOME>/personal/action-fabric.db`.
- Version 0 creates schema version 1 atomically.
- Repeated initialization is idempotent.
- A future schema version is rejected.
- Foreign keys are enabled.
- Required tables and indexes exist.
- Failed migration rolls back without a partial version update.

Use this required table set:

```ts
const REQUIRED_TABLES = [
  'fabric_meta',
  'fabric_capabilities',
  'fabric_executors',
  'fabric_executor_capabilities',
  'fabric_action_intents',
  'fabric_workflows',
  'fabric_steps',
  'fabric_policy_decisions',
  'fabric_budget_ledger',
  'fabric_audit_events',
  'fabric_outbox',
  'fabric_control_state',
]
```

### Step 2: Run the test and verify RED

Run:

```bash
npx vitest run tests/server/action-fabric-database.test.ts --reporter=verbose
```

Expected: FAIL because the Action Fabric module does not exist.

### Step 3: Define strict kernel types

Define at minimum:

```ts
export type FabricRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'
export type FabricEnvironment = 'simulator' | 'internal' | 'sandbox' | 'production'
export type FabricPolicyOutcome = 'allow' | 'deny' | 'waiting_user'
export type FabricWorkflowState =
  | 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating'
  | 'succeeded' | 'denied' | 'cancelled' | 'failed' | 'dead_letter' | 'compensated'

export interface FabricCapability {
  id: string
  version: number
  domain: string
  verb: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  risk: FabricRisk
  sideEffect: boolean
  idempotency: 'required' | 'supported' | 'none'
  reversible: boolean
  compensationCapabilityId: string | null
  verificationStrategy: string
  authentication: string[]
  targetRestrictions: string[]
  cost: { currency: string | null; estimatedMinor: number }
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface FabricActionIntentInput {
  capabilityId: string
  requestedByRoleId: string
  requestedByUserId: string
  idempotencyKey: string
  goal: string
  target: Record<string, unknown>
  input: Record<string, unknown>
  constraints: Record<string, unknown>
  rationale: string
  expectedCost?: { currency: string; amountMinor: number }
}
```

Add executor, intent, workflow, step, policy decision, audit, control, outbox, evidence, and list-option interfaces. Use bounded JSON objects rather than `any`.

### Step 4: Implement schema v1

Use WAL, `foreign_keys = ON`, `busy_timeout`, and one migration transaction. Important constraints:

- Capability IDs and executor IDs are primary keys.
- Executor-capability bindings reference both parents with cascade delete.
- Intent idempotency uses a unique `(requested_by_user_id, requested_by_role_id, idempotency_key)` index.
- One workflow belongs to one intent; compensation links may reference another intent.
- Step ordinals are unique within a workflow.
- Lease owner and lease expiry are nullable together.
- Audit sequence is monotonic and hashes are non-null.
- Outbox topics and payloads are bounded by service validation.
- Control table has exactly one row with level `0..3` and a monotonic version.

Export:

```ts
getActionFabricDbPath(): string
initActionFabricSchema(db: DatabaseSync): void
withActionFabricDb<T>(operation: (db: DatabaseSync) => T): T
```

### Step 5: Verify GREEN and typecheck

```bash
npx vitest run tests/server/action-fabric-database.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
```

Expected: PASS.

### Step 6: Commit

```bash
git add packages/server/src/services/hermes/action-fabric/types.ts packages/server/src/services/hermes/action-fabric/database.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-database.test.ts
git commit -m "feat: add action fabric schema"
```

## Task 2: Capability and Executor Registry

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/registry.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-registry.test.ts`

### Step 1: Write failing registry tests

Cover:

- Initial seeding creates exactly `simulator.echo`, `simulator.counter.increment`, and `internal.twin.preference.set`.
- Simulator and internal executor registrations are idempotent and do not overwrite edits or disabled state.
- Unsupported executor types such as `mcp` and `browser` are rejected in Phase 3 registration APIs.
- Capability contracts reject malformed IDs, non-object schemas, invalid risk, negative cost, missing verification, or impossible compensation declarations.
- Executor bindings require matching contract versions.
- Resolution is deterministic and prefers enabled healthy executors in the permitted environment.
- Changing executor risk/environment requires a new policy evaluation token.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-registry.test.ts --reporter=verbose
```

Expected: FAIL because registry exports do not exist.

### Step 3: Implement validation and seeds

Export:

```ts
ensureBuiltInFabricRegistry(): void
listFabricCapabilities(): FabricCapability[]
getFabricCapability(id: string): FabricCapability | null
listFabricExecutors(): FabricExecutor[]
setFabricExecutorEnabled(id: string, enabled: boolean): FabricExecutor
updateFabricExecutorHealth(id: string, health: FabricExecutorHealth): FabricExecutor
resolveFabricExecutor(capabilityId: string, options: { environments: FabricEnvironment[] }): ResolvedFabricExecutor | null
```

Use semantic IDs matching:

```ts
/^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)+$/
```

Keep JSON schema and descriptions bounded. Store a contract digest so later executors cannot silently change action semantics under the same version.

Seed bindings:

```text
simulator.echo              -> simulator-main
simulator.counter.increment -> simulator-main
internal.twin.preference.set -> internal-twin
```

All start in `simulator` or `internal`; no production external-write binding exists.

### Step 4: Run GREEN checks

```bash
npx vitest run tests/server/action-fabric-registry.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

### Step 5: Commit

```bash
git add packages/server/src/services/hermes/action-fabric/registry.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-registry.test.ts
git commit -m "feat: add capability executor registry"
```

## Task 3: Append-Only Audit, Outbox, and Control State

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/audit.ts`
- Create: `packages/server/src/services/hermes/action-fabric/control.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-audit.test.ts`

### Step 1: Write failing audit/control tests

Cover:

- Canonical serialization produces deterministic hashes.
- Every audit event references the previous hash.
- Tampering, deletion, and reordering are detected.
- Audit events cannot be updated or deleted through service APIs.
- Sensitive keys, key/value credentials, paths, connection strings, and raw errors are recursively redacted before persistence.
- Audit and outbox insert in the caller's existing transaction.
- Outbox publication is idempotent.
- Emergency control starts at level 0 and updates version atomically.
- Control updates create audit and outbox records in the same transaction.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-audit.test.ts --reporter=verbose
```

### Step 3: Implement safe canonical audit

Export:

```ts
appendFabricAuditEvent(db: DatabaseSync, input: FabricAuditEventInput): FabricAuditEvent
listFabricAuditEvents(options?: FabricAuditListOptions): FabricAuditEvent[]
verifyFabricAuditChain(): { valid: boolean; checked: number; firstInvalidSequence: number | null }
appendFabricOutbox(db: DatabaseSync, topic: string, aggregateId: string, payload: Record<string, unknown>): FabricOutboxRecord
listPendingFabricOutbox(limit?: number): FabricOutboxRecord[]
markFabricOutboxPublished(id: string): void
getFabricControlState(): FabricControlState
setFabricEmergencyStop(level: 0 | 1 | 2 | 3, actorUserId: string, reason: string): FabricControlState
```

Hash canonical JSON of immutable fields plus `previousHash`. Do not hash database row IDs that are assigned after serialization unless they are included deterministically.

### Step 4: Verify and commit

```bash
npx vitest run tests/server/action-fabric-audit.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
git add packages/server/src/services/hermes/action-fabric/audit.ts packages/server/src/services/hermes/action-fabric/control.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-audit.test.ts
git commit -m "feat: add action fabric audit controls"
```

## Task 4: Enforced Role Policy and Budget Ledger

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/policy.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/types.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/assistant-roles.ts`
- Modify: `packages/server/src/controllers/hermes/assistant-roles.ts`
- Modify: `packages/client/src/api/hermes/assistant-roles.ts`
- Modify: `packages/client/src/components/hermes/profiles/AssistantRoleEditor.vue`
- Modify: `packages/client/src/components/hermes/profiles/assistant-role-messages.ts`
- Modify: `tests/server/assistant-roles-store.test.ts`
- Modify: `tests/server/assistant-roles-controller.test.ts`
- Modify: `tests/client/assistant-role-editor.test.ts`
- Create: `tests/server/action-fabric-policy.test.ts`

### Step 1: Write failing policy tests

Cover:

- Disabled/missing roles are denied.
- Allow is required and deny wins.
- Existing Phase 2 scopes migrate from `declarative_phase_2` to `action_fabric_v1` without changing allow/deny arrays.
- Risk above `decisionAuthority.maxRisk` enters `waiting_user` or denies according to `requireApprovalAbove`.
- Target allowlists are literal and wildcard-free in v1.
- Per-action and daily limits are enforced transactionally.
- Concurrent reservations cannot exceed the daily limit.
- Currency mismatch denies.
- Emergency-stop levels affect intent creation and execution.
- Material input digest changes invalidate a previous decision.
- Decision persistence and budget reservation are atomic.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-policy.test.ts tests/server/assistant-roles-store.test.ts --reporter=verbose
```

### Step 3: Activate enforcement contracts

Change the capability scope type to:

```ts
enforcement: 'declarative_phase_2' | 'action_fabric_v1'
```

Add an idempotent migration that upgrades existing stored scopes when Action Fabric initializes. New edits must persist `action_fabric_v1`; reads may accept the legacy value only until migration completes. Update the feature-local UI notice to say permissions are enforced by Action Fabric and external executors remain unavailable.

### Step 4: Implement policy evaluation

Export:

```ts
evaluateFabricPolicy(input: FabricPolicyInput): FabricPolicyDecision
reserveFabricBudget(decisionId: string): FabricBudgetReservation
commitFabricBudget(workflowId: string, actual?: FabricMoney): void
releaseFabricBudget(workflowId: string): void
```

Use stable reason codes such as:

```text
role_missing
role_disabled
capability_not_allowed
capability_denied
executor_unavailable
target_not_allowed
risk_requires_approval
per_action_limit_exceeded
daily_limit_exceeded
currency_mismatch
emergency_stop
material_input_changed
```

Never persist raw sensitive input. Persist a sanitized summary and SHA-256 digest.

### Step 5: Verify and commit

```bash
npx vitest run tests/server/action-fabric-policy.test.ts tests/server/assistant-roles-store.test.ts tests/server/assistant-roles-controller.test.ts tests/client/assistant-role-editor.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
git diff --check
git add packages/server/src/services/hermes/action-fabric/policy.ts packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/assistant-roles.ts packages/server/src/controllers/hermes/assistant-roles.ts packages/client/src/api/hermes/assistant-roles.ts packages/client/src/components/hermes/profiles/AssistantRoleEditor.vue packages/client/src/components/hermes/profiles/assistant-role-messages.ts tests/server/action-fabric-policy.test.ts tests/server/assistant-roles-store.test.ts tests/server/assistant-roles-controller.test.ts tests/client/assistant-role-editor.test.ts
git commit -m "feat: enforce assistant role action policy"
```

## Task 5: Durable Intents and Workflow Store

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/workflows.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-workflows.test.ts`

### Step 1: Write failing workflow tests

Cover:

- Creating an intent resolves capability/executor and stores policy before workflow creation.
- Duplicate idempotency keys return the original intent/workflow and do not add audit events.
- Denied intents never create executable steps.
- Waiting-user intents create a waiting workflow with no lease.
- Only legal transitions are accepted.
- Every transition writes audit and outbox atomically.
- Step ordinals and execution tokens are stable.
- User approval requires unchanged material input digest and policy version.
- Cancellation, retry, and compensation eligibility are explicit.
- List queries are bounded and deterministic.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-workflows.test.ts --reporter=verbose
```

### Step 3: Implement the durable service

Export:

```ts
createFabricIntent(input: FabricActionIntentInput): FabricIntentResult
getFabricIntent(id: string): FabricActionIntent | null
getFabricWorkflow(id: string): FabricWorkflowDetail | null
listFabricWorkflows(options?: FabricWorkflowListOptions): FabricWorkflowSummary[]
approveFabricWorkflow(id: string, actorUserId: string): FabricWorkflowDetail
rejectFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail
cancelFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail
retryFabricWorkflow(id: string, actorUserId: string): FabricWorkflowDetail
requestFabricCompensation(id: string, actorUserId: string, reason: string): FabricWorkflowDetail
```

Centralize legal transitions in one explicit transition map. Callers never pass the destination state directly.

### Step 4: Verify and commit

```bash
npx vitest run tests/server/action-fabric-workflows.test.ts tests/server/action-fabric-policy.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git add packages/server/src/services/hermes/action-fabric/workflows.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-workflows.test.ts
git commit -m "feat: add durable action workflows"
```

## Task 6: Executor Contract and Simulator Adapters

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/executors.ts`
- Create: `packages/server/src/services/hermes/action-fabric/simulator.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-simulator.test.ts`

### Step 1: Write failing executor tests

Cover:

- Executors implement prepare, execute, verify, interrupt, and compensate contracts.
- Raw exceptions become sanitized stable executor outcomes.
- Evidence is bounded and secret/path redacted.
- Echo is deterministic.
- Counter increment is idempotent by execution token.
- Fixtures inject temporary failure, permanent failure, unknown outcome, verification mismatch, and compensation failure.
- Unknown outcome never reports safe-to-retry.
- Unsupported real executor types cannot register.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-simulator.test.ts --reporter=verbose
```

### Step 3: Implement the contract

```ts
export interface FabricExecutorAdapter {
  readonly id: string
  readonly type: 'simulator' | 'internal'
  prepare(context: FabricExecutionContext): Promise<FabricPrepareResult>
  execute(context: FabricExecutionContext): Promise<FabricExecuteResult>
  verify(context: FabricExecutionContext): Promise<FabricVerifyResult>
  interrupt(context: FabricExecutionContext): Promise<FabricInterruptResult>
  compensate(context: FabricExecutionContext): Promise<FabricCompensateResult>
}
```

The registry stores metadata; an in-process adapter map stores implementations. Adapter lookup must verify the stored ID/type/capability binding before invocation.

### Step 4: Verify and commit

```bash
npx vitest run tests/server/action-fabric-simulator.test.ts tests/server/action-fabric-registry.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
git add packages/server/src/services/hermes/action-fabric/executors.ts packages/server/src/services/hermes/action-fabric/simulator.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-simulator.test.ts
git commit -m "feat: add action simulator executors"
```

## Task 7: Worker, Leases, Retry, and Crash Recovery

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/worker.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/workflows.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Create: `tests/server/action-fabric-worker.test.ts`

### Step 1: Write failing worker tests

Use an injected clock and deterministic worker IDs. Cover:

- Only one worker acquires a workflow.
- Live leases cannot be stolen.
- Expired leases are recoverable after restart.
- Already verified steps are never executed again.
- Prepare, execute, and verify checkpoints persist before advancing.
- Temporary failures schedule bounded exponential retry.
- Retry exhaustion enters dead-letter.
- Unknown outcomes enter waiting-user without retry.
- Verification mismatch retries or compensates according to the capability contract.
- Circuit breaker opens after repeated adapter failures and disables resolution.
- Level 2 emergency stop interrupts only interruptible active work.
- Worker logs contain IDs and error classes, not raw payloads.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-worker.test.ts --reporter=verbose
```

### Step 3: Implement one-cycle and managed worker APIs

Export:

```ts
processActionFabricOnce(options?: { workerId?: string; now?: Date }): Promise<FabricWorkerCycleResult>
startActionFabricWorker(options?: FabricWorkerOptions): FabricWorkerHandle
stopActionFabricWorker(): Promise<void>
```

The timer must be `unref()`-safe, prevent overlapping cycles, and expose a deterministic one-cycle function for tests. Use condition-based state checks, not arbitrary sleeps.

### Step 4: Verify and milestone review

```bash
npx vitest run tests/server/action-fabric-worker.test.ts tests/server/action-fabric-workflows.test.ts tests/server/action-fabric-simulator.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
```

Use `@superpowers:requesting-code-review` over Tasks 1–7. Fix every Critical and Important finding.

### Step 5: Commit

```bash
git add packages/server/src/services/hermes/action-fabric/worker.ts packages/server/src/services/hermes/action-fabric/workflows.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/action-fabric-worker.test.ts
git commit -m "feat: run durable action workflows"
```

## Task 8: Reversible Personal Twin Preference Executor

**Files:**

- Modify: `packages/server/src/services/hermes/personal-twin/types.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/store.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/index.ts`
- Create: `packages/server/src/services/hermes/action-fabric/internal-preference.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/executors.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/index.ts`
- Modify: `tests/server/personal-twin-store.test.ts`
- Create: `tests/server/action-fabric-internal-preference.test.ts`

### Step 1: Write failing preference-store tests

Add typed canonical preference operations:

```ts
getTwinPreference(subjectId: string, domain: TwinDomain, key: string): TwinPreference | null
setTwinPreference(input: TwinPreferenceInput): TwinPreference
deleteTwinPreference(subjectId: string, domain: TwinDomain, key: string): void
```

Test reserved IDs, domains, bounded keys/values, provenance, outbox, idempotent updates, and deletion.

### Step 2: Write failing executor tests

Cover:

- Prepare captures whether the preference existed and its exact prior value/provenance.
- Execute writes through the canonical Twin store.
- Verify reads canonical state.
- Duplicate execution token does not duplicate Twin outbox events.
- Compensation restores prior value or removes a newly created value.
- Compensation itself is durable and audited.
- Sensitive preference keys/values are forbidden.
- A Twin failure leaves the workflow recoverable without a false success record.

### Step 3: Verify RED

```bash
npx vitest run tests/server/personal-twin-store.test.ts tests/server/action-fabric-internal-preference.test.ts --reporter=verbose
```

### Step 4: Implement and verify

Use `source = 'action-fabric'` and deterministic `sourceId` values derived from intent/workflow/step IDs. Never write directly to `twin.db` from the executor.

```bash
npx vitest run tests/server/personal-twin-store.test.ts tests/server/action-fabric-internal-preference.test.ts tests/server/action-fabric-worker.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
```

### Step 5: Commit

```bash
git add packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/store.ts packages/server/src/services/hermes/personal-twin/index.ts packages/server/src/services/hermes/action-fabric/internal-preference.ts packages/server/src/services/hermes/action-fabric/executors.ts packages/server/src/services/hermes/action-fabric/index.ts tests/server/personal-twin-store.test.ts tests/server/action-fabric-internal-preference.test.ts
git commit -m "feat: execute reversible twin preferences"
```

## Task 9: Runtime Lifecycle and Emergency Stop Enforcement

**Files:**

- Create: `packages/server/src/services/hermes/action-fabric/runtime.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/services/shutdown.ts`
- Create: `tests/server/action-fabric-runtime.test.ts`
- Modify: `tests/server/shutdown.test.ts`

### Step 1: Write failing lifecycle tests

Cover:

- Bootstrap initializes registry/policy migration before starting the worker.
- Tests and explicitly disabled environments can suppress background polling.
- Repeated start is idempotent.
- Shutdown awaits worker stop before database/process cleanup.
- Level 1 rejects new intents.
- Level 2 interrupts eligible work and preserves non-interruptible work in waiting-user.
- Level 3 disables every future external-write executor and calls a safe no-op revocation hook in Phase 3.
- A control version change invalidates stale worker leases/policy decisions.

### Step 2: Verify RED

```bash
npx vitest run tests/server/action-fabric-runtime.test.ts tests/server/shutdown.test.ts --reporter=verbose
```

### Step 3: Implement lifecycle

Export:

```ts
startActionFabricRuntime(): Promise<void>
stopActionFabricRuntime(): Promise<void>
isActionFabricRuntimeEnabled(env?: NodeJS.ProcessEnv): boolean
```

Use `HERMES_ACTION_FABRIC_DISABLED` as an explicit operational kill switch in addition to persisted emergency stop. Do not start timers merely by importing the module.

### Step 4: Verify and commit

```bash
npx vitest run tests/server/action-fabric-runtime.test.ts tests/server/shutdown.test.ts tests/server/action-fabric-worker.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
git add packages/server/src/services/hermes/action-fabric/runtime.ts packages/server/src/index.ts packages/server/src/services/shutdown.ts tests/server/action-fabric-runtime.test.ts tests/server/shutdown.test.ts
git commit -m "feat: manage action fabric runtime"
```

## Task 10: Protected Action Fabric HTTP API

**Files:**

- Create: `packages/server/src/controllers/hermes/action-fabric.ts`
- Create: `packages/server/src/routes/hermes/action-fabric.ts`
- Modify: `packages/server/src/routes/index.ts`
- Create: `tests/server/action-fabric-controller.test.ts`
- Create: `tests/server/action-fabric-routes.test.ts`

### Step 1: Write failing controller tests

Cover:

- Capability/executor discovery.
- Intent creation and idempotent replay.
- Workflow list/detail.
- Approve, reject, cancel, retry, and compensate.
- Audit list and chain verification.
- Control-state read and emergency-stop mutation.
- Explicit body allowlists, bounded strings/JSON, money parsing, and pagination.
- Stable 400/403/404/409/422/503 errors.
- Database paths, credentials, raw adapter errors, and internal table names never leak.

### Step 2: Write failing route tests

Register:

```text
GET  /api/hermes/action-fabric/capabilities
GET  /api/hermes/action-fabric/executors
POST /api/hermes/action-fabric/intents
GET  /api/hermes/action-fabric/workflows
GET  /api/hermes/action-fabric/workflows/:id
POST /api/hermes/action-fabric/workflows/:id/approve
POST /api/hermes/action-fabric/workflows/:id/reject
POST /api/hermes/action-fabric/workflows/:id/cancel
POST /api/hermes/action-fabric/workflows/:id/retry
POST /api/hermes/action-fabric/workflows/:id/compensate
GET  /api/hermes/action-fabric/audit
GET  /api/hermes/action-fabric/audit/verify
GET  /api/hermes/action-fabric/control
PUT  /api/hermes/action-fabric/control/emergency-stop
```

All POST/PUT routes require `requireSuperAdmin`. All routes mount after global auth.

### Step 3: Verify RED

```bash
npx vitest run tests/server/action-fabric-controller.test.ts tests/server/action-fabric-routes.test.ts --reporter=verbose
```

### Step 4: Implement strict controllers and routes

Controllers delegate state transitions to services and never accept a desired workflow state. Intent `requestedByUserId` comes from authenticated server context, never the body. Verify `requestedByRoleId` against stored roles.

### Step 5: Verify and commit

```bash
npx vitest run tests/server/action-fabric-controller.test.ts tests/server/action-fabric-routes.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
git add packages/server/src/controllers/hermes/action-fabric.ts packages/server/src/routes/hermes/action-fabric.ts packages/server/src/routes/index.ts tests/server/action-fabric-controller.test.ts tests/server/action-fabric-routes.test.ts
git commit -m "feat: expose action fabric api"
```

## Task 11: Typed Client API and Pinia State

**Files:**

- Create: `packages/client/src/api/hermes/action-fabric.ts`
- Create: `packages/client/src/stores/hermes/action-fabric.ts`
- Create: `tests/client/action-fabric-api.test.ts`
- Create: `tests/client/action-fabric-store.test.ts`

### Step 1: Write failing client tests

Cover every endpoint, URL encoding, methods, body shapes, and response unwrapping. Ensure there is no generic raw executor invocation method.

Store state:

```ts
capabilities
executors
workflows
selectedWorkflowId
selectedWorkflow
audit
control
loading
saving
error
```

Test authoritative refresh after every mutation, out-of-order detail responses, selection invalidation, retryable errors, and stale audit/control responses.

### Step 2: Verify RED

```bash
npx vitest run tests/client/action-fabric-api.test.ts tests/client/action-fabric-store.test.ts --reporter=verbose
```

### Step 3: Implement typed API/store

Use explicit DTOs mirroring safe server responses. After approve/reject/cancel/retry/compensate/control mutations, reload the affected workflow and relevant lists. Sequence tokens must prevent old detail/control responses from replacing newer state.

### Step 4: Verify and commit

```bash
npx vitest run tests/client/action-fabric-api.test.ts tests/client/action-fabric-store.test.ts --reporter=dot
npx vue-tsc -b
git diff --check
git add packages/client/src/api/hermes/action-fabric.ts packages/client/src/stores/hermes/action-fabric.ts tests/client/action-fabric-api.test.ts tests/client/action-fabric-store.test.ts
git commit -m "feat: add action fabric client state"
```

## Task 12: Action Center and Capability UI

**Files:**

- Create: `packages/client/src/components/hermes/action-fabric/ActionFabricPanel.vue`
- Create: `packages/client/src/components/hermes/action-fabric/WorkflowDetailDrawer.vue`
- Create: `packages/client/src/components/hermes/action-fabric/CapabilityRegistryPanel.vue`
- Create: `packages/client/src/components/hermes/action-fabric/EmergencyStopPanel.vue`
- Create: `packages/client/src/components/hermes/action-fabric/action-fabric-messages.ts`
- Modify: `packages/client/src/views/hermes/ProfilesView.vue`
- Create: `tests/client/action-fabric-panel.test.ts`
- Create: `tests/client/action-fabric-workflow-detail.test.ts`
- Create: `tests/client/action-fabric-emergency-stop.test.ts`
- Modify: `tests/client/profiles-view.test.ts`

### Step 1: Write failing UI tests

Cover:

- Profiles page has Runtime Profiles, Assistant Roles, and Action Fabric tabs.
- Action Center groups running, waiting, failed/recoverable, reversible, and completed workflows.
- Detail drawer shows role, capability, policy reason, sanitized steps/evidence, retry history, audit references, and compensation eligibility.
- Waiting-user approve/reject actions.
- Retry, cancel, and compensate confirmations.
- Capability registry shows risk, executor, environment, health, idempotency, reversibility, and role authorization.
- Emergency stop clearly describes levels 0–3 and requires confirmation.
- Simulator/internal-only banner; no UI claims real MCP/browser execution.
- Loading, empty, validation, degraded, retry, stale selection, and out-of-order states.
- Keyboard focus, native buttons, accessible labels, status announcements, and no interactive-control nesting.

### Step 2: Verify RED

```bash
npx vitest run tests/client/action-fabric-panel.test.ts tests/client/action-fabric-workflow-detail.test.ts tests/client/action-fabric-emergency-stop.test.ts tests/client/profiles-view.test.ts --reporter=verbose
```

### Step 3: Build feature-local UI

Use a typed English/Chinese feature-local message table selected from `vue-i18n` locale. Do not modify global locale files. Mount one `ActionFabricPanel` in a third `ProfilesView` tab. The panel must consume only server/store state and never reconstruct policy decisions client-side.

### Step 4: Verify and milestone review

```bash
npx vitest run tests/client/action-fabric-panel.test.ts tests/client/action-fabric-workflow-detail.test.ts tests/client/action-fabric-emergency-stop.test.ts tests/client/profiles-view.test.ts tests/client/action-fabric-store.test.ts --reporter=dot
npx vue-tsc -b
git diff --check
```

Use `@superpowers:requesting-code-review` over Tasks 8–12. Fix every Critical and Important finding.

### Step 5: Commit

```bash
git add packages/client/src/components/hermes/action-fabric/ActionFabricPanel.vue packages/client/src/components/hermes/action-fabric/WorkflowDetailDrawer.vue packages/client/src/components/hermes/action-fabric/CapabilityRegistryPanel.vue packages/client/src/components/hermes/action-fabric/EmergencyStopPanel.vue packages/client/src/components/hermes/action-fabric/action-fabric-messages.ts packages/client/src/views/hermes/ProfilesView.vue tests/client/action-fabric-panel.test.ts tests/client/action-fabric-workflow-detail.test.ts tests/client/action-fabric-emergency-stop.test.ts tests/client/profiles-view.test.ts
git commit -m "feat: add action fabric center"
```

## Task 13: OpenAPI, MCP Discovery, Full Verification, and Handoff

**Files:**

- Modify: `scripts/generate-openapi.mjs`
- Modify: `bin/hermes-web-ui-mcp.mjs`
- Modify: `tests/server/api-docs-controller.test.ts`
- Modify: `tests/server/llm-prompt.test.ts`
- Modify: `docs/openapi.json`

### Step 1: Write failing contract tests

Assert all Action Fabric paths, request bodies, path/query parameters, stable response schemas, and tags. MCP discovery must explain capability discovery, intent creation, workflow review, audit, and emergency stop while explicitly stating that only simulator/internal executors are available in Phase 3.

### Step 2: Verify RED

```bash
npx vitest run tests/server/api-docs-controller.test.ts tests/server/llm-prompt.test.ts --reporter=verbose
```

### Step 3: Update generator and MCP hints

Add route tag mapping and improve generic inference only where needed. Do not hard-code the whole OpenAPI document. Generate from a clean detached worktree if unrelated dirty auth/Health sources create drift.

### Step 4: Run focused Phase 3 suite

```bash
npx vitest run \
  tests/server/action-fabric-database.test.ts \
  tests/server/action-fabric-registry.test.ts \
  tests/server/action-fabric-audit.test.ts \
  tests/server/action-fabric-policy.test.ts \
  tests/server/action-fabric-workflows.test.ts \
  tests/server/action-fabric-simulator.test.ts \
  tests/server/action-fabric-worker.test.ts \
  tests/server/action-fabric-internal-preference.test.ts \
  tests/server/action-fabric-runtime.test.ts \
  tests/server/action-fabric-controller.test.ts \
  tests/server/action-fabric-routes.test.ts \
  tests/client/action-fabric-api.test.ts \
  tests/client/action-fabric-store.test.ts \
  tests/client/action-fabric-panel.test.ts \
  tests/client/action-fabric-workflow-detail.test.ts \
  tests/client/action-fabric-emergency-stop.test.ts \
  tests/client/profiles-view.test.ts \
  tests/server/api-docs-controller.test.ts \
  --reporter=dot --maxWorkers=4
```

Expected: PASS.

### Step 5: Run source regressions

```bash
npx vitest run \
  tests/server/personal-twin-store.test.ts \
  tests/server/assistant-roles-store.test.ts \
  tests/server/assistant-role-context.test.ts \
  tests/server/assistant-role-runtime-context.test.ts \
  tests/server/shutdown.test.ts \
  tests/client/assistant-roles-store.test.ts \
  tests/client/assistant-roles-panel.test.ts \
  --reporter=dot --maxWorkers=4
```

Expected: PASS.

### Step 6: Run static and harness verification

```bash
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
npm run harness:check
npm run openapi:generate
git diff --check
```

Expected: all exit 0 and generated OpenAPI is deterministic.

### Step 7: Run the complete suite

```bash
npm test -- --reporter=dot --maxWorkers=4
```

Expected: exit 0 with only documented platform skips.

### Step 8: Audit repository scope

```bash
git status --short
git diff --name-status 3a68f966..HEAD
git ls-files | rg '(action-fabric\.db|\.sqlite$|\.log$|credential|secret)'
git log --oneline --max-count=30
```

Expected:

- No database, credential, log, cache, evidence, or temporary artifact is tracked.
- Existing unrelated auth, Health, scale, router, sidebar, and locale changes remain unstaged.
- Phase 3 commits contain only planned files.

### Step 9: Final review

Use `@superpowers:requesting-code-review` over the complete Phase 3 commit range. Fix all Critical and Important findings, then rerun Steps 4–8.

### Step 10: Commit docs and hand off

```bash
git add scripts/generate-openapi.mjs bin/hermes-web-ui-mcp.mjs tests/server/api-docs-controller.test.ts tests/server/llm-prompt.test.ts docs/openapi.json
git commit -m "docs: expose action fabric operations"
```

Report exact evidence for:

- Capability and executor registry behavior.
- Enforced role allow/deny and spending policy.
- Durable state transitions, leases, restart recovery, and idempotency.
- Simulator success/failure/unknown-result behavior.
- Reversible Twin preference execution and compensation.
- Audit hash-chain verification and emergency stop.
- Protected API, client concurrency, Action Center, OpenAPI, and MCP discovery.
- Focused tests, regressions, type checks, harness, and full suite.

Do not claim that real MCP, browser, payment, Home Assistant, desktop, or Android execution is available.

