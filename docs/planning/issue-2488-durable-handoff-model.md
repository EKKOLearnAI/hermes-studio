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
  lastAuditEventId,
  auditCount,
  signature
}
```

The Source accepts a status only when the proof matches the response,
including the latest Target audit event and count. Completion additionally
requires:

```ts
{
  publicationId,
  messageId,
  messageDigest,
  committedAt,
  source: "durable-agent-message"
}
```

`synthetic:*` IDs are not valid evidence. The publication evidence and Target
`completed` transition represent one Target transaction boundary.

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
| `handoff_terminal_publication` | publication ID, real message ID, message digest, commit timestamp, source marker | same Target transaction as `completed` |
| `handoff_target_audit` | authenticated actor, authorization ID, attempt, reason, ordered event ID | Target transaction that changes the inbox |
| status proof | Target ID, inbox ID, version, status, latest audit event ID/count, signature | Target status read from durable state |

`cancelled` is also the Target tombstone. It prevents a late admission from
creating executable work for the cancelled identity. A Target that has an
invocation marker can never become `cancelled`; authenticated cancellation
instead produces `failed_manual`.

## State transitions and transaction boundaries

| Event | Source transaction | Target transaction | Result |
| --- | --- | --- | --- |
| create attempt | create chain, attempt, admit outbox, source audit | none | Source `pending` |
| send admit | `pending/sent` outbox -> `sent`, source audit | none | replayable request |
| admit | none | create `admitted` inbox and receipt, or replay exact inbox | one inbox/receipt |
| receive admit | validate Target proof/identity; set receipt and `admitted` | none | Source admission acknowledged |
| claim | none | `admitted -> claimed`, lease and version, audit | ownership before invocation |
| invocation marker | none | `claimed -> running`, invocation marker, execution ID/count, audit | invocation boundary committed |
| Target restart before marker | none | `claimed -> admitted`, release lease, audit | safe re-claim |
| Target restart after marker | none | `running -> failed_manual`, release lease, audit | no automatic retry |
| publish terminal | none | atomically persist real publication evidence and `running -> completed` | only valid completion |
| request cancel | set chain/attempt/outbox to `cancel_pending`, source audit | none | retryable cancellation |
| send cancel | preserve Source `cancel_pending`, source audit | `admitted/claimed -> cancelled` or `running -> failed_manual`; absent inbox creates tombstone | authenticated Target result |
| reconcile status | verify Target proof; map Target terminal to Source terminal and audit | none | Source convergence after callback loss |
| replace | authorized failed attempt -> `replaced`; create new pending attempt/outbox and lineage; source audit | none | explicit replacement only |
| source restart | reload durable Source records | none | no volatile completion assumption |
| Target restart | none | apply crash-boundary recovery above | no duplicate invocation |

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
   message digest, and publication time at or after the invocation marker.
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
12. Every status response is bound to the Target inbox version and latest
   audit event proof.
13. Source receipts are not duplicated in the outbox.
14. Chain terminal state agrees with its active attempt.
15. Local and Remote use the same transitions and invariants; only the
   target-kind label and opaque receipt differ.

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
| R5 | terminal callback lost, Source restart | `getStatus` proof reconciles to `completed` |
| R6 | cancellation while Target offline | durable `cancel_pending`, later `cancelled` |
| R7 | cancellation after marker | `failed_manual`, never `cancelled` |
| R8 | cancellation before admission | Target tombstone blocks late admission |
| R9 | Local and Remote trace | same normalized state/invariant result |
| R10 | invalid transport/operator authorization | `AUTH_REJECTED` |
| R11 | missing/synthetic terminal evidence | `TERMINAL_EVIDENCE_INVALID` |
| R12 | illegal transition sequence | `ModelViolation`, no implicit repair |

The initial implementation intentionally exposed RED failures in the focused
suite, including unstable replay response data, incorrect cancellation
outbox convergence, and an incomplete identity conflict test. The corrected
model now passes all 15 focused tests.
