# Issue #2482: durable handoff contract

> Stage A design-only spike. This document is the implementation contract for
> the Local/Remote durable handoff proof-of-concept. It does not add production
> routes, schema migrations, relay handlers, or Agent execution code.

- **Issue:** #2482
- **Branch:** `spike/2482-durable-handoff-contract`
- **Base:** `b1e1c0d50fc326ae1734f002cb2deb2a418f0cc5`
- **Scope:** Source outbox, independent Target SQLite inbox, authenticated
  admission/status/cancellation, crash boundaries, idempotent execution,
  terminal evidence, deletion and replacement semantics.
- **Out of scope:** #2458 UI/route integration, production Agent relay
  replacement, merge, packaging, release, installation, and deployment.

This revision is the single concentrated design rework. It addresses the nine
blocking findings from the first design review. Stage B remains closed until an
independent `DESIGN_PASS` is recorded against the resulting immutable commit.

## 1. Contract vocabulary and identities

The spike models two independently restartable processes:

- **Source:** owns the user-visible handoff chain and a durable outbox.
- **Target:** owns an independent SQLite database containing the inbox,
  execution record, terminal publication, tombstones, and audit events. A Local
  Target uses the same protocol in-process; it still has a separate database
  connection/file boundary. A Remote Target uses an authenticated transport
  adapter.

An **attempt** is one immutable delivery/execution identity. A manual retry
after an uncertain side effect is a replacement attempt, never a replay of the
old attempt. The canonical idempotency key is `(sourceInstanceId, attemptId)`.

`sourceInstanceId` is generated once at Source installation/bootstrap, stored in
Source durable state, and never regenerated on process restart. Rotation is an
explicit administrative migration that creates a new installation identity and
cannot reuse old attempt IDs. The authenticated transport binding contains the
peer installation IDs and key identifier; request body identity fields are
checked against it, not trusted as authority.

The complete immutable attempt binding is:

```text
sourceInstanceId + attemptId + sourceChainId + roomId
+ targetInstanceId + targetAgentSnapshot + payloadDigest
```

The Target persists every member of this binding. A request that conflicts with
any persisted member, authenticated peer identity, payload digest, or canonical
snapshot is rejected without changing the existing row.

## 2. Durable schemas

JSON fields are canonical JSON (stable key ordering and no insignificant
whitespace) before their digest is calculated. `actorId`, `reason`, and
`occurredAt` below are required audit values, not optional log text.

### 2.1 Source chain

`handoff_chain` is the user-visible aggregate:

| Column | Meaning |
| --- | --- |
| `chain_id` | Primary key and immutable source chain identity. |
| `room_id`, `source_message_id` | Originating room and continuation message. |
| `current_attempt_id` | The only attempt eligible for this chain. |
| `status` | `stopped`, `continuing`, `resumed`, `failed_manual`, or `cancelled`. |
| `continue_used` | Set only when the chain reaches `resumed`. |
| `stop_reason`, `last_error` | Bounded operator-visible state. |
| `tombstone_actor_id`, `tombstone_reason`, `tombstoned_at` | Cancellation audit. |
| `created_at`, `updated_at` | Millisecond timestamps. |

Only the Source reconciliation writer may transition `continuing` to
`resumed`. Replacement changes `current_attempt_id` only inside the atomic
replacement transaction.

### 2.2 Source attempt

`handoff_attempt` is append-only in identity and lineage:

| Column | Meaning |
| --- | --- |
| `attempt_id`, `chain_id`, `room_id` | Immutable identities and aggregate reference. |
| `replaces_attempt_id` | Prior terminal attempt for an authorized replacement. |
| `source_instance_id` | Persistent Source installation identity. |
| `target_instance_id` | Target identity copied from authenticated binding. |
| `target_agent_snapshot_json` | Canonical target identity/version/config snapshot. |
| `payload_digest` | SHA-256 of canonical payload. |
| `status` | `pending`, `admitted`, `claimed`, `running`, `resumed`, `failed_terminal`, `failed_manual`, or `cancelled`. |
| `target_inbox_id`, `target_receipt` | The sole Source copy of Target admission identity/receipt. |
| `target_state_version`, `execution_id` | Monotonic reconciliation evidence. |
| `failure_reason` | Bounded terminal failure reason. |
| `created_at`, `updated_at`, `finished_at` | Audit timestamps. |

Constraints:

```sql
UNIQUE (source_instance_id, attempt_id)
CHECK (replaces_attempt_id IS NULL OR replaces_attempt_id <> attempt_id)
```

`target_receipt` is the single Source fact. The outbox has no duplicate
`receipt_json`; dispatchers join/read the attempt row in the same Source
transaction. An attempt that has entered `running`, `resumed`,
`failed_terminal`, `failed_manual`, or `cancelled` cannot be re-executed.

### 2.3 Source outbox

`handoff_outbox` is the reliable delivery record:

| Column | Meaning |
| --- | --- |
| `attempt_id` | Unique foreign identity to the attempt. |
| `payload_json`, `payload_digest` | Exact canonical admission payload and digest. |
| `status` | `pending`, `dispatching`, `delivered`, `failed_manual`, or `cancelled`. |
| `delivery_attempts`, `next_attempt_at` | Retry accounting and backoff. |
| `last_error`, `lease_until` | Bounded transport error and dispatcher lease. |
| `created_at`, `updated_at` | Audit timestamps. |

`delivered` means only that Source durably recorded the Target receipt in
`handoff_attempt`. It never means that the Agent ran or completed.

### 2.4 Target inbox and execution

These tables belong to the independent Target SQLite database and must not be
additional rows in Source SQLite.

`handoff_inbox`:

| Column | Meaning |
| --- | --- |
| `inbox_id` | Opaque durable receipt subject; primary key. |
| `source_instance_id`, `attempt_id`, `source_chain_id`, `room_id` | Full Source identity binding. |
| `target_instance_id` | Derived from authenticated local Target identity. |
| `target_agent_snapshot_json` | Canonical snapshot bound at admission. |
| `payload_digest`, `payload_json` | Immutable admitted payload. |
| `receipt_hash` | Server-generated opaque receipt verifier. |
| `state` | `admitted`, `claimed`, `running`, `completed`, `failed_terminal`, `failed_manual`, or `cancelled`. |
| `state_version` | Starts at `1`, increments on every state mutation. |
| `execution_id`, `lease_until` | Stable execution identity and claim lease. |
| `invocation_started_at` | Written by the invocation-marker transaction. |
| `terminal_publication_id` | Durable successful terminal publication identity. |
| `last_error`, `tombstone_actor_id`, `tombstone_reason`, `tombstoned_at` | Failure and cancellation audit. |
| `created_at`, `updated_at`, `finished_at` | Audit timestamps. |

Mandatory constraints and indexes:

```sql
UNIQUE (source_instance_id, attempt_id)
INDEX (source_instance_id, attempt_id, source_chain_id)
INDEX (state, lease_until)
```

The unique key is the only admission identity. `source_chain_id` is persisted
and compared; the index is for lookup/audit, not an alternate identity.

`handoff_terminal_publication`:

| Column | Meaning |
| --- | --- |
| `publication_id` | Primary key generated by the Target message repository. |
| `inbox_id`, `execution_id`, `attempt_id` | Owning Target execution and binding. |
| `message_id` | ID returned by the same transaction that inserts the target-room terminal message. |
| `message_digest` | Digest of the persisted terminal content. |
| `published_at` | Commit timestamp. |

```sql
UNIQUE (inbox_id, execution_id)
UNIQUE (message_id)
```

`handoff_audit_event`:

| Column | Meaning |
| --- | --- |
| `event_id` | Durable event identity. |
| `inbox_id`, `attempt_id`, `chain_id` | Event subject. |
| `event_type` | Admission, claim, invocation, completion, failure, cancel, replace, or recovery event. |
| `actor_id`, `authorization_id`, `reason`, `occurred_at` | Who/why/when evidence. |
| `state_version`, `metadata_json` | Version and bounded canonical details. |

`UNIQUE (inbox_id, state_version, event_type)` makes replayed writes idempotent.

## 3. Authenticated transport contract

The business protocol has three operations: `admit`, `getStatus`, and
`cancel`. `cancel` is required for cross-database tombstoning. Socket callbacks
may notify Source but are only wake-up hints and never truth.

### 3.1 Common authentication

`AuthBinding` is established by the configured peer authentication layer and
contains `sourceInstanceId`, `targetInstanceId`, `keyId`, authorized room/agent
scope, and an authenticated request nonce/signature. The Target derives its
own `targetInstanceId` and agent identity from the authenticated peer/session.
Caller-supplied fields that disagree with the binding are rejected. Nonces are
replay-protected; authorization failures are audited without revealing whether
an unrelated inbox exists.

### 3.2 Admission

```ts
type AdmitRequest = {
  sourceInstanceId: string
  attemptId: string
  sourceChainId: string
  roomId: string
  targetSnapshot: TargetSnapshot
  payloadDigest: string
  payload: HandoffPayload
  authBinding: AuthBinding
}

type AdmissionReceipt = {
  sourceInstanceId: string
  attemptId: string
  sourceChainId: string
  targetInstanceId: string
  inboxId: string
  receipt: string
  state: 'admitted' | 'claimed' | 'running' | 'completed' |
    'failed_terminal' | 'failed_manual' | 'cancelled'
  stateVersion: number
}
```

The Target transaction authenticates and validates the request, then either
inserts one `admitted` row, receipt, and `admission` audit event, or compares
all immutable binding fields and returns the existing receipt/state as
`already`. It never executes during admission. A response lost after commit is
safe to replay.

### 3.3 Status

```ts
type GetStatusRequest = {
  sourceInstanceId: string
  attemptId: string
  receipt: string
  authBinding: AuthBinding
}

type TargetStatus = AdmissionReceipt & {
  executionId: string | null
  terminalPublicationId: string | null
  messageId: string | null
  failureReason: string | null
  finishedAt: number | null
}
```

The Target checks receipt and authenticated source scope and returns a
consistent row/publication snapshot. Source restart queries every nonterminal
attempt with a receipt; callback loss therefore cannot prevent convergence.

### 3.4 Cancellation/tombstone

```ts
type CancelRequest = {
  sourceInstanceId: string
  attemptId: string
  sourceChainId: string
  receipt: string
  actorId: string
  authorizationId: string
  reason: string
  authBinding: AuthBinding
}
```

`cancel` is authenticated, idempotent, and ordered by Target state version. In
one Target transaction it rechecks the receipt/binding and current state,
writes the tombstone audit event, and transitions `admitted`/`claimed` to
`cancelled`. If `invocation_started_at` is set, it transitions to
`failed_manual` with reason `cancel_after_invocation` instead; it never claims
that an unknown side effect was cancelled. A `running` row without an
invocation marker is cancelled only while its claim lease is owned and before
invocation. Offline cancellation remains a Source tombstone/outbox state and a
retryable authenticated Target `cancel`; the Target worker checks tombstone
state immediately before every claim and invocation marker.

### 3.5 Version and receipt rules

- `stateVersion` is strictly monotonic per inbox.
- Source applies a response only when its version is newer, or idempotently
  reapplies the same version with identical binding and evidence.
- A same-version difference in state, receipt, digest, snapshot, or terminal
  evidence is a protocol violation and fails closed.
- Receipt bytes are opaque and unguessable, stable for replay, and stored only
  in `handoff_attempt`; callbacks cannot supply or mutate them.
- Local and Remote use the same state/version/error semantics. Their opaque
  receipt values need not be equal; R7 checks replay stability and semantic
  parity, never identical random strings.

## 4. Two-phase claim/invocation and write ownership

### 4.1 Source transitions

| From | To | Writer | Guard/evidence |
| --- | --- | --- | --- |
| chain `stopped` | `continuing` | Source route/command | One transaction creates one attempt/outbox. |
| attempt `pending` | `admitted` | Source reconciler | Target receipt stored in attempt; outbox becomes `delivered`. |
| attempt `admitted` | `claimed` | Source reconciler | Target status reports `claimed`. |
| attempt `claimed` | `running` | Source reconciler | Target status reports invocation marker and execution ID. |
| attempt `running` | `resumed` | Source reconciler only | Target status has committed publication/message evidence. |
| attempt `running` | `failed_manual/failed_terminal` | Source reconciler | Authenticated Target terminal status and audit. |
| attempt `pending/admitted/claimed` | `failed_manual` | Dispatcher/reconciler | Bounded offline/retry exhaustion or operator action. |
| any nonterminal attempt | `cancelled` | Source tombstone transaction | Source cancellation audit and Target cancel attempt. |
| chain `continuing` | `resumed` | Source reconciler only | Current attempt is `resumed`; evidence verified. |
| chain `continuing` | `failed_manual/cancelled` | Reconciler/tombstone writer | Current attempt terminal and reason recorded. |

Target `failed_manual`/`failed_terminal` maps Source to the same terminal class;
Target `cancelled` maps Source to `cancelled` only when no invocation marker
exists, otherwise to `failed_manual`. Source never infers a terminal result
from transport success, callback, or executor Promise resolution.

### 4.2 Target transitions and crash barriers

| From | To | Writer | Guard/evidence |
| --- | --- | --- | --- |
| absent | `admitted` | Target admission transaction | Binding, receipt, and audit committed. |
| `admitted` | `claimed` | Target worker claim transaction | Execution ID and lease committed; no tombstone. |
| `claimed` | `running` | Target invocation-marker transaction | Same execution ID; marker committed immediately before Agent call. |
| `running` | `completed` | Target terminal transaction | Real terminal message insert and publication row commit atomically. |
| `running` | `failed_terminal` | Target worker | Failure proves no successful side effect. |
| `claimed` | `admitted` | Target recovery | Crash before invocation marker; lease expired and no marker. |
| `running` | `failed_manual` | Target recovery/operator | Marker exists but terminal evidence is unknown. |
| `admitted/claimed` | `cancelled` | Target cancel transaction | Tombstone visible before invocation marker. |
| `running` | `failed_manual` | Target cancel transaction | Invocation already started; no false cancellation. |
| terminal state | no execution state | none | Absorbing; only reconciliation metadata may be recorded. |

There are two separate commits by design:

1. **Claim barrier:** transaction writes `claimed`, stable `executionId`, lease,
   and audit event. Crash here is recoverable: after lease expiry, recovery
   verifies no invocation marker and returns the row to `admitted`.
2. **Invocation barrier:** transaction rechecks tombstone and lease ownership,
   writes `running`, `invocationStartedAt`, increments `stateVersion`, and
   commits immediately before the Agent call. Crash after this commit makes the
   side effect unknown; recovery writes `failed_manual`, records the barrier,
   and forbids automatic re-invocation.

A worker may call the Agent only after the invocation-barrier commit and only
once for an execution ID. `completed` is written only by the terminal
transaction, which inserts the real target-room terminal message through the
message repository and inserts `handoff_terminal_publication` using that
committed message ID in the same SQLite transaction. The repository must expose
one transaction-scoped publication primitive; a generated/synthetic ID,
callback, Promise, or Socket event cannot satisfy the constraint.

## 5. Retry, replacement, cancellation, and deletion

### 5.1 Transport retry and reconciliation

- Before admission is durably acknowledged, Source retries the same attempt and
  canonical payload. After a receipt is known, it uses `getStatus` (and may
  replay `admit`) without creating an attempt.
- Busy is backoff while Target remains `admitted`/`claimed`; it is not success.
- Offline retry exhaustion records `failed_manual` with count, last error, and
  audit event. No automatic replacement is created.
- Source restart reconciles every receipt-bearing nonterminal attempt. Lower
  Target versions are ignored; equal versions must be byte-identical.

### 5.2 Manual replacement

`replaceFailedAttempt` is a Source-side protected operation, valid only for an
unreplaced `failed_manual` or `failed_terminal` attempt. It requires an
`authorizationId`, `actorId`, and reason, and atomically:

1. verifies old attempt terminality and no existing replacement;
2. inserts a fresh attempt with `replacesAttemptId=oldAttemptId`;
3. creates its outbox and updates `current_attempt_id`;
4. writes a `replace` audit event containing actor, authorization, reason, and
   lineage.

Old identity, receipt, execution ID, errors, audit, and terminal evidence stay
immutable. A replacement is never made for an attempt with unknown execution
outcome except after it has explicitly become `failed_manual`.

### 5.3 Cross-database deletion ordering

Deletion is a two-phase, fail-closed protocol, not one pretend distributed
transaction:

1. Source transaction writes chain/attempt/outbox tombstones with actor, reason,
   timestamp, increments a cancellation generation, and prevents new claims.
2. Source retries authenticated Target `cancel` until it receives a terminal
   Target status. Target transaction wins races by rechecking tombstone and
   invocation marker under its own lock.
3. Source marks cancellation complete only after Target status is terminal. If
   Target is offline, Source remains `cancel_pending`/`failed_manual` for audit;
   it never reports deletion as complete and never permits a replacement or
   execution.

Target tombstones are durable and checked by admission conflict, worker claim,
invocation marker, recovery, and status reconciliation. A late admission for a
Source-tombstoned attempt is rejected. Physical cleanup is out of scope.

## 6. Required invariants

1. One `(sourceInstanceId, attemptId)` and full chain binding map to at most one Target inbox.
2. Authenticated installation identity cannot be overridden by caller fields.
3. One Target inbox maps to at most one execution ID and one publication.
4. `completed` implies one committed real terminal message and matching publication.
5. Source `resumed` implies a current-or-newer verified Target completion snapshot.
6. `delivered` implies only a receipt stored in `handoff_attempt`.
7. Target and Source-applied versions never decrease; equal versions are identical.
8. Payload/snapshot/chain/room mismatch is rejected without mutation.
9. `failed_manual` and `cancelled` are absorbing for execution.
10. Only one chain attempt is current; replacements preserve immutable lineage.
11. Callback loss cannot prevent `getStatus` convergence.
12. Source and Target can restart independently without losing evidence.
13. No memory queue, Promise, callback, or synthetic ID is admission/completion evidence.
14. A tombstoned record cannot be claimed or invoked.
15. Every cancellation, recovery, replacement, and authorization decision has durable actor/reason/time evidence.
16. Local and Remote implement the same protocol state machine and crash outcomes.

## 7. RED test matrix for the spike

Tests use real Source and Target SQLite databases and a real protocol adapter.
They inject crashes by throwing at the named barrier, close/reopen the affected
process/database, and exercise route-equivalent service calls. They must not
mock admission, Target persistence, the message repository, or terminal
publication. Each vector records before/after DB snapshots, protocol calls,
Agent invocation count, inbox/execution/publication IDs, receipts, versions,
audit events, and final Source/Target states.

| ID | Failure injection | RED assertion before implementation | GREEN evidence required |
| --- | --- | --- | --- |
| R1 | Target commits inbox, drops admit response | Replay duplicates row or loses receipt | One inbox, stable replay receipt/inbox ID, zero Agent calls. |
| R2 | Target commits publication/completed, drops callback | Source stays nonterminal or reruns | Restarted Source `getStatus` reaches `resumed` once. |
| R3 | Two dispatchers admit concurrently | Two inboxes/executions | Unique binding yields one inbox and one execution. |
| R4 | Duplicate and stale status/callback responses | Source regresses or double-publishes | Monotonic apply; one publication and audit sequence. |
| R5 | Crash after claim commit, before invocation-marker commit | Replay duplicates or cannot reclaim | Lease recovery returns to `admitted`; zero calls before one eventual call. |
| R6 | Crash after invocation marker, before terminal publication | Replay calls Agent twice or reports success | Recovery writes `failed_manual`; no second call; audit is complete. |
| R7 | Run all vectors on Local and independent Remote Targets | Remote depends on memory/callback | Same states, versions, rejection/error classes, replay stability, and call counts; opaque receipt values may differ. |
| R8 | Existing key changes payload, snapshot, chain, room, or auth identity | Target reuses old inbox | Auth/conflict rejection; original row, receipt, and evidence unchanged. |
| R9 | Busy/offline retries and max retry | Busy looks complete or loops forever | Busy remains nonterminal; exhaustion is audited `failed_manual`. |
| R10 | Authorized replacement after failure | Old attempt reused or lineage lost | Fresh ID, authorization audit, one current attempt, old record immutable. |
| R11 | Tombstone at pending, admitted, claimed, running-before-marker, and after-marker | Worker executes after deletion or audit disappears | Pre-marker becomes `cancelled`; post-marker becomes `failed_manual`; no rerun; Source converges. |
| R12 | Full source transaction through real admit, claim, marker, Agent, message publication, status reconcile | Helpers/mocks make a false GREEN | One real terminal message/publication transaction, exact IDs, and Source `resumed`. |

R8 explicitly covers `sourceChainId` binding and authenticated caller mismatch.
R11 explicitly covers invocation-after-delete and crash-after-invocation-marker.
R12 must verify the message row and publication row commit atomically, not merely
assert an HTTP response or executor return.

## 8. Stage A exit gate

Stage A is complete only when the design reviewer can answer “yes” to all of:

- Are Source, Target, and message-publication storage boundaries independently restartable?
- Is source chain identity persisted and authenticated at Target?
- Are claim and invocation separate, with deterministic recovery at each barrier?
- Is every Source/Target transition assigned to one writer and terminal mapping explicit?
- Is authenticated cross-database cancellation fail-closed and auditable?
- Is `completed` tied to a real message/publication transaction?
- Can admission and status converge without callbacks?
- Is invocation-after-crash permanently prevented from automatic replay?
- Are replacement, deletion, authorization, actor, reason, and time evidence durable?
- Does every R1–R12 test have a real failure barrier and observable evidence?

No production implementation or Draft PR may start until this document is
independently marked `DESIGN_PASS`.
