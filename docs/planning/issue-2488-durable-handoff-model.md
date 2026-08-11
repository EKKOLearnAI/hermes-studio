# Issue #2488: Formal Local/Remote Durable Handoff Model

Date: 2026-08-11
Stage: A, design-only
Implementation: `tests/server/models/durable-handoff-model.ts`
Model tests: `tests/server/durable-handoff-formal-model.test.ts`

This document is the executable protocol contract for the Stage A model. It
does not define production routes, services, relay behavior, database
migrations, or UI changes.

## Identity and protocol schema

The durable identity is:

```text
(sourceInstanceId, chainId, attemptId, targetId, snapshotDigest, payloadDigest)
```

The Target inbox key is `(sourceInstanceId, attemptId)`. A replay with the
same key must match every identity and digest field. A replay with any changed
field is rejected; a different source instance is a different durable sender,
not an overwrite of the first sender.

Every transport operation carries an `AuthBinding`:

```ts
{
  kind: "transport",
  operation: "admit" | "getStatus" | "cancel",
  principal: string,
  sourceInstanceId: string,
  targetId: string,
  authorizationId: string,
  capabilityScope: string,
  requestDigest: string,
  signature: string
}
```

Operator operations use the same shape with `kind: "operator"` and operation
`"cancel" | "replace"`. The model rejects an operation, source instance,
Target, principal, or signature mismatch before changing durable state.

`TargetStatusResponse` is authenticated by a Target status proof:

```ts
{
  targetId,
  inboxId,
  version,
  status,
  responseDigest,
  lastAuditEventId,
  auditCount,
  signature
}
```

The request digest covers the operation, full attempt identity, snapshot and
payload digests, and cancellation reason when present. The capability scope
binds the principal to the exact Source, Target, chain, and attempt. The
Source accepts a status only when the proof matches the complete response,
including identity/digests, invocation fields, terminal evidence, failure
reason, ordered audit IDs, latest Target audit event, and count.

Completion additionally requires durable Target rows:

```ts
{
  publicationId,
  messageId,
  messageDigest,
  committedAt,
  source: "durable-agent-message"
}
```

`synthetic:*` IDs are not valid evidence. The Agent message row, content
digest, publication row, inbox `completed` transition, and terminal audit
event are committed by one Target transaction. The model never accepts
caller-supplied publication evidence as a substitute for those rows.

## Durable state dictionary

### Source SQLite

| Record | States/fields | Unique writer |
| --- | --- | --- |
| `handoff_chain` | `continuing`, `cancel_pending`, `completed`, `cancelled`, `failed_manual`; active attempt | Source coordinator transaction |
| `handoff_attempt` | `pending`, `admitted`, `claimed`, `running`, `cancel_pending`, `completed`, `cancelled`, `failed_manual`, `replaced`; identity, receipt, cancel reason, replacement lineage, last Target version | Source coordinator/reconciler transaction |
| `handoff_outbox` | `pending`, `sent`, `acknowledged`, `cancel_pending`, `completed`, `cancelled`, `failed_manual`; operation and request ID | Source dispatcher transaction |
| `handoff_source_audit` | actor, authorization ID, attempt, reason, timestamp, ordered event ID | Source transaction that changes the related state |

The Target receipt is stored once, on `handoff_attempt.targetReceipt`.
Outbox rows refer to the attempt and never copy a second `receipt_json` fact.
`cancelReason` is durable on the attempt so an offline cancellation can be
retried with the original reason.

### Target SQLite

| Record | States/fields | Unique writer |
| --- | --- | --- |
| `handoff_inbox` | `admitted`, `claimed`, `running`, `completed`, `cancelled`, `failed_manual`; full source identity, receipt, version, lease, invocation marker, execution ID/count, failure reason | Target admission/executor/recovery transaction |
| `handoff_agent_message` | real message ID, content, content digest, attempt, commit timestamp | same Target transaction as `completed` |
| `handoff_terminal_publication` | publication ID, real message ID, message digest, commit timestamp, source marker | same Target transaction as `completed` |
| `handoff_target_audit` | authenticated actor, authorization ID, attempt, reason, ordered event ID | Target transaction that changes the inbox |
| status proof | full response digest, Target ID, inbox ID, version, status, latest audit event ID/count, signature | Target status read from durable state |

`cancelled` is also the Target tombstone. It prevents a late admission from
creating executable work for the cancelled identity. A Target that has an
invocation marker can never become `cancelled`; authenticated cancellation
instead produces `failed_manual`.

## State transitions and transaction boundaries

| Event | Source transaction | Target transaction | Result |
| --- | --- | --- | --- |
| create attempt | create chain, attempt, admit outbox, source audit | none | Source `pending` |
| send admit | `pending/sent` outbox -> `sent`, source audit | none | replayable request |
| admit | none | create `admitted` inbox and receipt, or replay exact inbox; a tombstone replay stays cancelled | one inbox/receipt |
| receive admit | validate Target proof/identity; set receipt and `admitted` | none | Source admission acknowledged |
| claim | none | `admitted -> claimed`, lease and version, audit | ownership before invocation |
| invocation marker | none | `claimed -> running`, invocation marker, execution ID/count, audit | invocation boundary committed |
| Target restart before marker | none | `claimed -> admitted`, release lease, audit | safe re-claim |
| Target restart after marker | none | `running -> failed_manual`, release lease, audit | no automatic retry |
| publish terminal | none | atomically persist real message row, content digest, publication, audit, and `running -> completed` | only valid completion |
| request cancel | set chain/attempt/outbox to `cancel_pending`, source audit | none | retryable cancellation |
| send cancel | preserve Source `cancel_pending`, source audit | `admitted/claimed -> cancelled` or `running -> failed_manual`; absent inbox creates tombstone | authenticated Target result |
| reconcile status | verify Target proof; map Target terminal to Source terminal and audit | none | Source convergence after callback loss |
| replace | authorized failed attempt -> `replaced`; create new pending attempt/outbox and lineage; source audit | none | explicit replacement only |
| source restart | discard loaded Source view and reload its committed Source store | none | Target commits are not silently imported |
| Target restart | none | discard loaded Target view and reload its committed Target store, then apply crash-boundary recovery | no duplicate invocation |

Source and Target are separate durable stores in the executable model. A
Target commit followed by a lost callback leaves Source at its prior committed
state; a later `getStatus` response is the only reconciliation input.
Transport delivery and callback loss never write either database. A worker may
retry an outbox row, but only the owning Source or Target transaction may
change its durable state.

## Safety invariants

The reference model checks these after every event:

1. `(sourceInstanceId, attemptId)` has at most one Target inbox.
2. A replayed admission has identical identity/digests and a stable receipt and
   version.
3. `running`, `completed`, and `failed_manual` require a committed invocation
   marker.
4. `completed` requires durable-agent-message publication evidence, non-empty
   message digest, a matching committed message/publication row, and
   publication time at or after the invocation marker.
5. No `synthetic:*` publication or message ID can complete an inbox.
6. `invocationCount` is at most one.
7. Source `cancel_pending` requires chain `cancel_pending` and outbox
   `cancel_pending`; it is not a terminal success.
8. Source `cancelled` requires authenticated Target `cancelled` confirmation.
9. Source `failed_manual` requires authenticated Target `failed_manual`
   confirmation.
10. An invocation-marked Target cannot become `cancelled`.
11. A replacement requires authorized Source `failed_manual`, preserves
   `replacesAttemptId`/`replacementAttemptId`, and records an audit event.
12. Every status response is bound to the complete Target response, inbox
   version and ordered audit event proof; stale responses cannot regress a
   newer Source version.
13. Source receipts are not duplicated in the outbox.
14. Chain terminal state agrees with its active attempt.
15. Local and Remote use the same transitions and invariants; only the
   target-kind label and opaque receipt differ.
16. Source and Target stores can independently reload their last committed
   state after a crash.
17. A stale admission callback cannot clear Source `cancel_pending`.
18. `failed_manual` is terminal for ordinary cancellation and automatic
   rerun.

There is no automatic `failed_terminal` transition after invocation. An
Agent error, connection loss, process crash, or missing publication evidence
is an unknown side-effect boundary and therefore must be `failed_manual`.

## Executable fault matrix

The Vitest model suite is the RED/GREEN executable matrix:

| ID | Fault/sequence | Required result |
| --- | --- | --- |
| R1 | duplicate admit after lost response | one inbox, stable receipt/version |
| R2 | same attempt with changed source/payload identity | `IDENTITY_CONFLICT` |
| R3 | claim then Target restart before marker | `admitted`, re-claimable, invocation count 0 |
| R4 | marker then Target restart | `failed_manual`, no re-claim |
| R5 | terminal callback lost, Source restart, independent store reload | `getStatus` proof reconciles to `completed` without importing Target state |
| R6 | cancellation while Target offline | durable `cancel_pending`, later `cancelled` |
| R7 | cancellation after marker | `failed_manual`, never `cancelled` |
| R8 | cancellation before admission | Target tombstone blocks late admission |
| R9 | Local and Remote trace | same normalized state/invariant result |
| R10 | invalid principal, capability scope, or tampered full request digest | `AUTH_REJECTED` |
| R11 | missing/synthetic terminal evidence, missing message row, tampered status response, or wrong audit order | `TERMINAL_EVIDENCE_INVALID` / `STATUS_PROOF_INVALID` |
| R12 | illegal transition, expired status, stale admission, or `failed_manual -> cancel_pending` | `ModelViolation`, no implicit repair |

The focused suite first established six RED failures for the Stage A
rework: shared in-memory state, auto-generated terminal evidence, missing
response injection, incomplete request authentication, stale admission
rollback, and `failed_manual` reopening. After the concentrated model
correction it passes 22 tests, including the independent-store, atomic
publication, tampered/expired proof, and callback-loss scenarios.
