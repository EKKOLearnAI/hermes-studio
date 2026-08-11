# Issue #2482: durable handoff contract

> Stage A design-only spike. This document is the implementation contract for
> the Local/Remote durable handoff proof-of-concept. It does not add production
> routes, schema migrations, relay handlers, or Agent execution code.

- **Issue:** #2482
- **Branch:** `spike/2482-durable-handoff-contract`
- **Base:** `b1e1c0d50fc326ae1734f002cb2deb2a418f0cc5`
- **Scope:** Source outbox, independent Target SQLite inbox, `admit`,
  `getStatus`, crash boundaries, idempotent execution, and terminal evidence.
- **Out of scope:** #2458 UI/route integration, production Agent relay
  replacement, room deletion implementation, merge, packaging, release,
  installation, and deployment.

## 1. Contract vocabulary

The spike models two independently restartable processes:

- **Source:** owns the user-visible handoff chain and a durable outbox.
- **Target:** owns an independent SQLite database containing the inbox and
  execution record. A Local Target uses the same protocol in-process; a Remote
  Target uses an authenticated transport adapter. The storage boundary is not
  optional for Local.

An **attempt** is one immutable delivery/execution identity. A manual retry
after an uncertain side effect is a replacement attempt, not a replay of the
old attempt.

The canonical idempotency key is:

```text
(sourceInstanceId, attemptId)
```

The attempt binding is:

```text
sourceInstanceId
+ attemptId
+ source chain identity
+ target instance/agent snapshot
+ payloadDigest
```

The Target must reject an existing key when its payload digest or target
snapshot differs. It must never silently reuse an inbox for a different
payload, Agent identity, Agent version, or target instance.

## 2. Durable schemas

The exact SQL dialect may be adapted to the repository's schema helper, but
the following columns, constraints, and meanings are mandatory. JSON fields
are canonical JSON (stable key ordering and no insignificant whitespace) before
their digest is calculated.

### 2.1 Source chain

`handoff_chain` is the user-visible aggregate:

| Column | Meaning |
| --- | --- |
| `chain_id` | Primary key. |
| `room_id` | Source room identity. |
| `source_message_id` | Message that created the continuation. |
| `current_attempt_id` | The only attempt eligible for this chain. |
| `status` | `stopped`, `continuing`, `resumed`, `failed_manual`, or `cancelled`. |
| `continue_used` | Set only when the chain reaches `resumed`. |
| `stop_reason` | Original stop reason, if any. |
| `last_error` | Bounded operator-visible error. |
| `tombstone_reason` | Deletion/cancellation reason, nullable. |
| `created_at`, `updated_at` | Millisecond timestamps. |

Only the Source reconciliation writer may transition `continuing` to
`resumed`. `current_attempt_id` is immutable after a replacement is installed
except for the single atomic replacement transaction described below.

### 2.2 Source attempt

`handoff_attempt` is append-only in identity and lineage:

| Column | Meaning |
| --- | --- |
| `attempt_id` | Primary key; immutable execution identity. |
| `chain_id`, `room_id` | Source aggregate references. |
| `replaces_attempt_id` | Nullable prior attempt for manual replacement. |
| `source_instance_id` | Stable identity of this Source installation. |
| `target_instance_id` | Authenticated target installation identity. |
| `target_agent_snapshot_json` | Canonical target identity/version/config snapshot. |
| `payload_digest` | SHA-256 of canonical payload. |
| `status` | `pending`, `admitted`, `running`, `resumed`, `failed_terminal`, `failed_manual`, or `cancelled`. |
| `target_inbox_id`, `target_receipt` | Durable Target admission receipt. |
| `target_state_version` | Highest Target version applied by Source. |
| `execution_id` | Target execution identity once admitted to execution. |
| `failure_reason` | Bounded reason for terminal failure. |
| `created_at`, `updated_at`, `finished_at` | Audit timestamps. |

Constraints:

```sql
UNIQUE (source_instance_id, attempt_id)
CHECK (replaces_attempt_id IS NULL OR replaces_attempt_id <> attempt_id)
```

An attempt that reached `running`, `failed_manual`, `failed_terminal`, or
`cancelled` is immutable except for monotonic reconciliation metadata
(`target_state_version`, receipt, and timestamps). It may not be re-executed.

### 2.3 Source outbox

`handoff_outbox` is the reliable delivery record:

| Column | Meaning |
| --- | --- |
| `attempt_id` | Unique foreign identity to the attempt. |
| `payload_json` | Exact canonical admission payload. |
| `payload_digest` | Digest copied from the attempt. |
| `status` | `pending`, `dispatching`, `delivered`, `failed_manual`, or `cancelled`. |
| `delivery_attempts` | Number of transport/admission tries. |
| `next_attempt_at` | Backoff schedule. |
| `receipt_json` | Last durable Target receipt returned by `admit`. |
| `last_error` | Bounded transport/admission error. |
| `lease_until` | Source dispatcher lease. |
| `created_at`, `updated_at` | Audit timestamps. |

`delivered` means only that Source durably recorded the Target receipt. It
never means that the Agent ran or completed.

### 2.4 Target inbox and execution

The Target owns these tables in its own SQLite database. They must not be
implemented as additional rows in the Source database.

`handoff_inbox`:

| Column | Meaning |
| --- | --- |
| `inbox_id` | Opaque durable receipt subject; primary key. |
| `source_instance_id`, `attempt_id` | Idempotency key. |
| `target_instance_id` | Authenticated local Target identity. |
| `target_agent_snapshot_json` | Snapshot bound at admission. |
| `payload_digest`, `payload_json` | Immutable admitted payload. |
| `receipt_hash` | Server-generated opaque receipt verifier. |
| `state` | `admitted`, `running`, `completed`, `failed_terminal`, `failed_manual`, or `cancelled`. |
| `state_version` | Starts at `1`, increments on every state mutation. |
| `execution_id` | Stable execution identity; nullable before `running`. |
| `lease_until` | Worker lease; nullable outside `running`. |
| `invocation_started_at` | Set in the same transaction that grants execution ownership, immediately before the Agent call. |
| `terminal_publication_id` | Durable successful terminal publication identity. |
| `last_error`, `tombstone_reason` | Bounded audit data. |
| `created_at`, `updated_at`, `finished_at` | Audit timestamps. |

Mandatory constraints and indexes:

```sql
UNIQUE (source_instance_id, attempt_id)
UNIQUE (source_instance_id, attempt_id, payload_digest)
INDEX (state, lease_until)
```

The second unique index is not a substitute for the first. It makes the
payload binding explicit for the spike's conflict tests; the primary conflict
path is `(source_instance_id, attempt_id)`.

`handoff_terminal_publication`:

| Column | Meaning |
| --- | --- |
| `publication_id` | Primary key; the actual durable terminal message/event identity. |
| `inbox_id`, `execution_id` | Owning Target execution. |
| `attempt_id` | Source attempt identity. |
| `message_id` | Persisted target-room terminal message identity. |
| `message_digest` | Digest of the persisted terminal content. |
| `published_at` | Commit timestamp. |

Constraint:

```sql
UNIQUE (inbox_id, execution_id)
```

`completed` is legal only when this row is committed in the same Target
transaction as the inbox transition to `completed`. A Promise resolution,
queue insertion, Socket event, `run.accepted`, `run.completed`, or synthetic
message ID is not evidence.

## 3. Authenticated transport contract

The adapter has exactly two business operations. Socket callbacks may notify
the Source, but cannot be the source of truth.

### 3.1 Admission

```ts
admit(request): Promise<AdmissionReceipt>

type AdmitRequest = {
  sourceInstanceId: string
  attemptId: string
  sourceChainId: string
  targetSnapshot: TargetSnapshot
  payloadDigest: string
  payload: HandoffPayload
  authBinding: AuthBinding
}

type AdmissionReceipt = {
  sourceInstanceId: string
  attemptId: string
  targetInstanceId: string
  inboxId: string
  receipt: string
  state: 'admitted' | 'running' | 'completed' | 'failed_terminal' |
    'failed_manual' | 'cancelled'
  stateVersion: number
}
```

The Target authenticates the transport peer and derives
`targetInstanceId`/Agent identity from that authenticated binding. Caller
fields cannot impersonate another Target.

The Target transaction is:

1. authenticate and validate the request;
2. look up `(sourceInstanceId, attemptId)`;
3. if absent, insert one immutable inbox row with `admitted`, version `1`,
   and a cryptographically random opaque receipt;
4. if present, compare snapshot and digest byte-for-byte;
5. return the existing receipt and state/version as `already`.

The response may be lost after commit. A replay must therefore return the same
`inboxId` and receipt and must not insert or execute a second row.

### 3.2 Status

```ts
getStatus(request): Promise<TargetStatus>

type GetStatusRequest = {
  sourceInstanceId: string
  attemptId: string
  receipt: string
  authBinding: AuthBinding
}

type TargetStatus = AdmissionReceipt & {
  executionId: string | null
  terminalPublicationId: string | null
  failureReason: string | null
  finishedAt: number | null
}
```

The Target checks the receipt and authenticated source binding. It returns an
immutable snapshot of the current row. A callback is only a wake-up hint;
Source restart always performs `getStatus` for every nonterminal outbox with a
receipt and for every attempt whose last known Target version is nonterminal.

### 3.3 Version and receipt rules

- `stateVersion` is strictly monotonic per inbox.
- Source applies a response only when `response.stateVersion > storedVersion`,
  or idempotently re-applies the same version and same state.
- A lower version is ignored.
- A same version with different state, receipt, digest, snapshot, or terminal
  evidence is a protocol violation and fails closed.
- The receipt is opaque, unguessable, stored by Source only after admission,
  and never accepted from an unauthenticated callback.

## 4. State transition table and write ownership

### 4.1 Source transitions

| From | To | Writer | Guard/evidence |
| --- | --- | --- | --- |
| chain `stopped` | `continuing` | Source route/command | One transaction creates one attempt and outbox. |
| attempt `pending` | `admitted` | Source reconciler | Target admission receipt durably stored. |
| attempt `admitted` | `running` | Source reconciler | Target status says `running` with execution ID. |
| attempt `running` | `resumed` | Source reconciler only | Target status says `completed` and includes terminal publication. |
| attempt `pending/admitted` | `failed_manual` | Source dispatcher/reconciler | Bounded offline/retry exhaustion or explicit operator action. |
| attempt any nonterminal | `cancelled` | Source tombstone transaction | Room/Agent deletion or explicit cancellation. |
| chain `continuing` | `resumed` | Source reconciler only | Current attempt is `resumed`; terminal evidence verified. |
| chain `continuing` | `failed_manual/cancelled` | Source tombstone/reconciler | Current attempt terminal and reason recorded. |

The Source never derives `resumed` from `admit`, `delivered`, a callback, or
the return value of an executor function.

### 4.2 Target transitions

| From | To | Writer | Guard/evidence |
| --- | --- | --- | --- |
| absent | `admitted` | Target admission transaction | Inbox row committed. |
| `admitted` | `running` | Target worker transaction | Stable `executionId` and lease committed. |
| `running` | `completed` | Target terminal transaction | Successful terminal publication row committed atomically. |
| `running` | `failed_terminal` | Target worker | Failure proves no successful Agent side effect. |
| `running` | `failed_manual` | Target recovery/operator | Invocation began but terminal evidence is unknown. |
| `admitted` | `cancelled` | Target tombstone transaction | Source/Target tombstone visible before execution claim. |
| `running` | `cancelled` | Target tombstone transaction | Only if invocation has not started; otherwise `failed_manual`. |
| `completed/failed_* /cancelled` | no execution state | none | Terminal states are absorbing. |

The Target worker transaction immediately before the Agent call must set both
`executionId`/lease and `invocationStartedAt` atomically. If the process dies
before that transaction commits, no invocation occurred and the lease may be
reclaimed. If it dies after `invocationStartedAt` commits and before terminal
publication commits, the result is unknowable: recovery must write
`failed_manual`, and the same attempt must never call the Agent again.

## 5. Retry, replacement, and deletion semantics

### 5.1 Transport retry

- Before Target admission is durably acknowledged, Source may retry `admit`
  with the same attempt and payload.
- After a receipt is recorded, Source may retry `getStatus` or `admit`; it must
  not create a new attempt.
- Admission success plus Target busy leaves the Target row `admitted`; busy is
  backoff, not completion or rejection.
- Offline retries use bounded exponential backoff. Exhaustion writes
  `failed_manual` with attempt count and last transport error.
- A lease timeout with no `invocationStartedAt` can return Target to `admitted`
  and be safely retried.

### 5.2 Manual replacement

There is one protected operation, `replaceFailedAttempt`, for an authorized
operator. It is valid only for `failed_manual` or `failed_terminal` attempts.
It atomically:

1. verifies the old attempt is terminal and not already replaced;
2. inserts a new attempt with a fresh `attemptId` and
   `replacesAttemptId=oldAttemptId`;
3. creates its outbox;
4. updates the chain's `current_attempt_id`;
5. leaves the old attempt, receipt, execution identity, failure, and evidence
   immutable.

A transient attempt that never entered invocation may reuse its original
`attemptId`; no attempt in `failed_manual` may be reused.

### 5.3 Tombstones

Room or Agent deletion must first run a transaction that marks every
nonterminal chain, attempt, outbox, and Target inbox as `cancelled` (or
`failed_manual` when invocation state is unknown), recording actor, reason, and
timestamp. Workers and reconcilers must check this tombstone immediately before
their own claim/transition transaction.

The spike performs no physical cleanup. Terminal audit rows, lineage, receipts,
errors, leases, and timestamps remain permanently so a test can prove that
deletion does not permit later execution. A future retention policy must be a
separate contract.

## 6. Required invariants

1. One `(sourceInstanceId, attemptId)` maps to at most one Target inbox.
2. One Target inbox maps to at most one `executionId`.
3. An `executionId` is never regenerated by replay.
4. `completed` implies one committed terminal publication with matching
   `attemptId`, `inboxId`, and `executionId`.
5. `resumed` implies Source has read that immutable Target completion at a
   strictly current-or-newer `stateVersion`.
6. `delivered` implies a durable receipt only; it never implies execution.
7. Target versions and Source-applied versions never decrease.
8. A payload or target snapshot mismatch for an existing attempt is rejected.
9. `failed_manual` and `cancelled` are absorbing for execution.
10. Only one chain attempt is current; replacements preserve complete lineage.
11. Callback loss cannot prevent eventual status-query reconciliation.
12. Source and Target databases can be stopped independently without losing
    the contract's evidence.
13. No in-memory queue or Promise result is used as admission or completion
    evidence.
14. A tombstoned record cannot be claimed by a dispatcher, worker, or
    reconciler.

## 7. RED test matrix for the spike

The spike must implement these tests against real Source and Target SQLite
databases and a real protocol adapter. Tests may inject crashes by throwing at
the named barrier and reopening the database/process. They must not mock
admission, Target persistence, or terminal publication.

| ID | Failure injection | RED assertion before implementation | GREEN evidence required |
| --- | --- | --- | --- |
| R1 | Target commits inbox, then drops admission response | Replay creates a second row or loses the receipt | One inbox, same receipt/inbox ID, zero Agent calls. |
| R2 | Target commits terminal publication/completed, then drops callback | Source remains nonterminal or re-executes | Restarted Source `getStatus` advances exactly once to `resumed`. |
| R3 | Two Source dispatchers admit concurrently | Two inboxes or two executions appear | Unique key returns one `admitted/already`; one execution ID. |
| R4 | Duplicate callback and duplicate status responses, including old versions | Source regresses or writes completion twice | Monotonic version application and one terminal publication. |
| R5 | Target writes `running`/lease but crashes before invocation marker | Replay duplicates execution or cannot recover | Lease is reclaimed; Agent call count remains zero before one eventual call. |
| R6 | Target commits `invocationStartedAt`, Agent call begins, then crash before publication | Replay calls Agent twice or reports completion | Target becomes `failed_manual`; same attempt is never invoked again. |
| R7 | Local and independent Remote targets run the same vectors | Local passes while Remote depends on callback/memory | Identical receipts, states, version rules, and failure outcomes. |
| R8 | Existing key is admitted with altered payload digest or snapshot | Target silently reuses old inbox | Admission is rejected; original row/evidence unchanged. |
| R9 | Target is busy or offline across retries and max retry | Busy is treated as completion or retry loops forever | Busy remains `admitted`; offline exhaustion is `failed_manual` with audit. |
| R10 | Manual replacement after `failed_manual` | Old attempt is reused or lineage is lost | Fresh ID, `replacesAttemptId`, one current chain attempt, old record immutable. |
| R11 | Room/Agent tombstone at pending, admitted, and running-before-invocation | Worker executes after deletion or audit disappears | Cancelled tombstone blocks claims and preserves evidence. |
| R12 | Full route-equivalent source transaction through target publication | Test passes by calling persistence helpers directly | Source outbox → transport admit → target worker → terminal row → status reconcile. |

Each vector records: database snapshots before/after the barrier, number of
admission calls, number of Agent invocations, inbox count, execution IDs,
receipt, state versions, terminal publication IDs, and final Source/Target
states. A test that asserts only an HTTP response or a mocked executor return is
not a passing contract test.

## 8. Stage A exit gate

Stage A is complete only when the design reviewer can answer “yes” to all of:

- Are Source and Target storage boundaries independently restartable?
- Is every state transition assigned to one writer with an explicit guard?
- Is `completed` tied to a committed terminal publication?
- Can admission and status converge without callbacks?
- Is invocation-after-crash permanently prevented from automatic replay?
- Are replacement attempts and deletion tombstones auditable?
- Does every R1–R12 test have a real failure barrier and observable evidence?

No production implementation or Draft PR may start until this document is
independently marked `DESIGN_PASS`.
