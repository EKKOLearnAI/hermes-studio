# Commerce Autonomy Implementation Plan

**Goal:** Implement Phase 8 as a provider-neutral, budgeted commerce closed loop with enforced observe/shadow/live modes and fail-closed transaction recovery.

**Architecture:** Commerce owns normalized offer, cart, quote, order, payment, delivery, cancellation, and refund state. Action Fabric remains the only policy, budget, workflow, retry, approval, audit, and emergency-stop authority. Provider transports retain credentials and expose only bounded semantic operations.

## Time-boxed Delivery

- Batch A — domain truth and provider boundary: Tasks 1-4.
- Batch B — observe/shadow commerce loop: Tasks 5-7.
- Batch C — governed transactions and recovery: Tasks 8-11.
- Batch D — product surface and closure: Tasks 12-15.

Each task begins with focused failing coverage, implements the smallest durable contract, runs relevant TypeScript/tests, and commits only its files.

### Task 1: Commerce Contracts And Role Boundary

Define provider kinds, execution modes, money, offers, comparisons, carts, quotes, transaction states, payment/cancel/refund/delivery records, stable errors, and exact bounds. Add a dedicated Commerce Assistant role with no default live capability or spending authority.

### Task 2: Commerce Database

Create the dedicated versioned SQLite database under the Personal OS state root. Add constrained tables, foreign keys, unique idempotency/provider-event identities, immutable material fields, monotonic transitions, owner-only persistence behavior, schema signature checks, reopen, downgrade, and corruption tests.

### Task 3: Commerce Store And State Machine

Implement canonical digests, exact record creation, legal compare-and-set transitions, immutable cart revisions, quote expiry/invalidation, transaction checkpoints, pagination, replay identity, and secret-shaped field rejection.

### Task 4: Virtual Provider Contract

Define the bounded provider interface and deterministic virtual food-delivery/Taobao-shaped adapters. Cover quote change, effect-before-timeout, duplicate request, lookup, payment, delivery, cancellation, refund, malformed/oversized responses, and credential/raw-payload redaction.

### Task 5: Offer Observation And Comparison

Ingest bounded provider offer snapshots, deduplicate provider identities, expire stale observations, deterministically compare price/fulfillment/preferences/constraints, explain exclusions, and project minimized observations to the Personal Twin.

### Task 6: Cart And Quote Engine

Build immutable cart proposals, exact quantities, substitution and destination policy, full integer-minor quote breakdown, expiry, digest binding, material-change detection, and shadow quote receipts.

### Task 7: Commerce Action Fabric Capabilities

Register semantic search, compare, cart, quote, order, payment, delivery, cancel, and refund contracts. Resolve exact account/provider/merchant/currency/destination target atoms, add Commerce role authorization composition, and forbid raw provider/browser/Android primitives.

### Task 8: Commerce Executor Adapter

Implement prepare/execute/verify/interrupt over the provider boundary. Enforce mode separation, one workflow transaction identity, provider request idempotency, bounded evidence, read-after-write verification, stable retry classification, and terminal receipt replay.

### Task 9: Order And Payment Safety

Bind live order placement to an unexpired quote and reserved exact budget. Require fresh payment approval, separate order/payment identities, lookup-before-retry after uncertainty, exact charge verification, commit-once budget behavior, and same-workflow takeover for unknown state.

### Task 10: Delivery, Cancellation, And Refund

Normalize provider delivery events, enforce monotonic state, bind cancellation/refund to original orders and eligibility snapshots, verify receipts and amounts, project outcomes, and reject stale or cross-transaction requests.

### Task 11: Runtime Activation And Recovery

Add provider account mode/health lifecycle, super-admin activation review, recent-shadow gate, exact executor/destination/currency binding, emergency stop, revocation, restart recovery, circuit breaking, and policy-epoch invalidation.

### Task 12: Commerce API And OpenAPI

Add thin authenticated controllers/routes for overview, accounts, offers, comparisons, carts, quotes, workflows, transactions, delivery, cancellation, refunds, takeovers, and activation. Minimize DTOs, require super-admin for authority changes, and regenerate deterministic strict OpenAPI.

### Task 13: Commerce Studio Surface

Add typed API helpers, Pinia state, Personal OS route, provider/mode/activation panels, offer comparison, immutable cart and quote review, exact live confirmation, transaction timeline, delivery/cancel/refund controls, takeovers, all-locale messages, and mocked browser coverage.

### Task 14: Security And Compatibility Closure

Harden money/address/payment/provider redaction, bounds, receipt substitution, stale approval, cross-account and cross-destination attacks, mode escalation, raw primitive rejection, audit evidence, role coexistence with Internet/Android capabilities, and existing Action Center/role/UI compatibility.

### Task 15: End-to-End Closure

Use virtual food-delivery and Taobao-shaped providers to prove observe, shadow, compare, quote invalidation, budget reservation, exact approval, order/payment lookup-before-retry, restart replay, delivery, cancel, refund, takeover, revocation, emergency stop, and Twin projection. Run focused suites, browser tests, harness, TypeScript, production build, OpenAPI determinism, and final review.

