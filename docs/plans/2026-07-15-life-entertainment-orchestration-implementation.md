# Life and Entertainment Orchestration Implementation Plan

**Goal:** Implement Phase 9 as a constraint-first life and entertainment planner over canonical commitments, health, budget, preferences, subscriptions, and existing media projections, with all external writes governed by Action Fabric.

**Architecture:** Life Orchestration owns normalized life-source facts, frozen constraint snapshots, immutable leisure-plan revisions, calendar holds, subscription cancellation records, and cross-domain handoffs. Personal Twin owns shared facts and projections. Internet/Android own playback, Commerce owns purchases/bookings, and Action Fabric owns every write workflow.

## Time-boxed Delivery

- Batch A — domain truth and source boundary: Tasks 1-4.
- Batch B — cross-domain constraints and deterministic planning: Tasks 5-7.
- Batch C — governed writes and recovery: Tasks 8-11.
- Batch D — product surface and closure: Tasks 12-15.

Each task starts with focused failing coverage, implements one durable boundary, runs relevant TypeScript/tests, and commits only its files.

### Task 1: Contracts And Role Boundary

Define source kinds, modes, health states, commitments, contact aliases, options, subscriptions, constraint snapshots, plan candidates/sessions/revisions, calendar holds, cancellation records, handoffs, transitions, bounds, stable errors, and exact safe-data rules. Keep the Entertainment Assistant without default write authority.

### Task 2: Database

Create a dedicated versioned SQLite database under the Personal OS state root with constrained tables, immutable material columns, foreign keys, content identities, unique provider/request/event identities, monotonic states, schema signature, reopen/downgrade/corruption coverage, and owner-only persistence behavior.

### Task 3: Store And State Machines

Implement canonical digests, exact create/replay, compare-and-set transitions, immutable plan revisions, stale/superseded material, bounded listing, calendar-hold and subscription-cancellation checkpoints, and credential-shaped data rejection.

### Task 4: Virtual Source Adapters

Define bounded adapters and deterministic virtual calendar, contacts, travel, music, games, and subscription sources. Cover pagination bounds, replay, changed observations, malformed results, effect-before-timeout, timeout-before-effect, lookup, and minimized receipts.

### Task 5: Observation And Twin Projection

Normalize source records, deduplicate provider identities, expire stale options, project minimized entities/events/relations/observations, consume existing Bilibili entertainment entities, and prove idempotent replay.

### Task 6: Constraint Snapshot

Freeze commitments, free windows, timezone, health readiness/recovery/sleep-debt/screen-time, leisure time, exact budget, preferences, exclusions, radius, and all provenance digests. Treat missing or stale facts conservatively.

### Task 7: Deterministic Leisure Planner

Implement hard conflict and eligibility rules, stable scoring/tie-breaking, bounded selections, reason codes, total time/cost, immutable revisions, material-change invalidation, and cross-domain handoffs without granting receiving-domain authority.

### Task 8: Action Fabric Capabilities

Register source sync, plan verify, calendar hold create/cancel, and subscription cancel contracts. Resolve exact account/source/calendar/plan/subscription/currency atoms and forbid raw provider/browser/Android/payment primitives.

### Task 9: Executor Adapter

Implement prepare/execute/verify/interrupt/compensate with cross-step stable material binding, mode separation, bounded evidence, provider request idempotency, and read-after-write verification.

### Task 10: Calendar And Subscription Safety

Bind calendar holds to one current plan revision and exact time window. Bind subscription cancellation to one current subscription and eligibility snapshot. Use lookup-before-retry, verified receipts, stable replay, and same-workflow takeover for uncertainty.

### Task 11: Runtime Activation And Recovery

Add source-account mode/health lifecycle, super-admin activation review, recent-shadow gates, exact source/calendar/subscription bindings, emergency stop, revocation, circuit breaking, policy-epoch invalidation, and restart recovery.

### Task 12: API And OpenAPI

Add thin authenticated controllers/routes for overview, sources, commitments, contacts, options, subscriptions, constraints, plans, handoffs, workflows, holds, cancellations, takeovers, and activation. Minimize DTOs, restrict authority changes, and regenerate deterministic strict OpenAPI.

### Task 13: Studio Surface

Add typed API helpers, Pinia state, Personal OS route, Today/Sources/Planner/Library/Subscriptions/Workflow panels, material-change review, exact confirmations, takeovers, all-locale messages, and mocked browser coverage.

### Task 14: Security And Compatibility Closure

Harden contact/location/provider text minimization, credential redaction, bounds, stale-plan and cross-account attacks, receipt substitution, mode escalation, raw primitive rejection, audit evidence, and coexistence with Health/Home/Internet/Android/Commerce roles and routes.

### Task 15: End-to-End Closure

Use all virtual source kinds plus existing Bilibili Twin projections to prove observation, deterministic health/commitment/budget/preference constraints, plan invalidation, approval, calendar hold, subscription cancellation, uncertainty recovery, restart replay, handoff isolation, revocation, emergency stop, and Twin projection. Run focused suites, UI tests, TypeScript, OpenAPI determinism, and production build.

