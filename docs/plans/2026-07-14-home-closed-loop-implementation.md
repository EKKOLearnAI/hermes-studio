# Home Closed Loop Implementation Plan

**Goal:** Implement Phase 5 as a Personal Twin Home domain pack with Home Assistant live events and policy-governed, state-verified device control.

**Architecture:** Global Twin persistence owns semantic home state. A bounded Home Assistant adapter supplies provider events and commands. Action Fabric owns all external writes, approvals, retries, verification, and audit.

## Time-boxed Delivery

- Batch A — foundation: Tasks 1-3.
- Batch B — live observation: Tasks 4-7.
- Batch C — governed execution: Tasks 8-11.
- Batch D — product surface and closure: Tasks 12-15.

Each task starts with a failing focused test, implements the smallest contract, runs server TypeScript where relevant, and commits only its files.

### Task 1: Home Twin Contracts And Schema

Create `home/types.ts` and `home/store.ts`; migrate Personal Twin schema to v11 with spaces, objects, inventory, inventory ledger, devices, bindings, device states, provider events, provider cursors, and command receipts. Add exact column/index/check assertions and upgrade/reopen tests.

### Task 2: Home Twin Write Service

Add strict create/upsert/list APIs for spaces, objects, devices, bindings, and state. Enforce provider identity uniqueness, optimistic versions, parent/space integrity, canonical JSON, stale-event rejection, and idempotent replay.

### Task 3: Inventory And Placement Ledger

Add append-only inventory adjustments, non-negative quantity enforcement, object/device placement relationships, low-stock projections, and generic Twin event/outbox mirroring.

### Task 4: Home Assistant Configuration

Resolve profile-scoped `home_assistant` configuration and credentials with URL safety, token fingerprints, bounded timeouts, sanitized status, and no secret persistence.

### Task 5: Home Assistant Protocol Client

Implement REST bootstrap plus WebSocket auth, `subscribe_events`, ping/pong, byte/depth limits, abort, bounded reconnect inputs, and deterministic fake-server contract tests.

### Task 6: Entity And Event Normalization

Normalize allowlisted entity domains, devices, areas, capabilities, attributes, timestamps, and `state_changed` events. Reject poison keys, oversized values, unknown command surfaces, and stale/duplicate events.

### Task 7: Durable Subscription Runtime

Bootstrap, subscribe, reconnect with bounded backoff, persist provider cursors/health, ingest events into Home Twin, and resume after restart without duplicate state transitions.

### Task 8: Home Projections And Rules

Project room environment, device availability, stale sensors, inventory warnings, and maintenance signals. Produce explainable safe-action candidates without executing them directly.

### Task 9: Home Action Fabric Contracts

Register refresh, power, level, temperature, and safe-scene capabilities with exact target atoms, schemas, risk, environment, authorization requirements, idempotency, verification strategy, and dangerous-domain denials.

### Task 10: Home Assistant Command Executor

Map semantic inputs to allowlisted services, persist execution receipts, handle uncertain outcomes safely, and verify against an exact subsequent event/read-back state.

### Task 11: Production Authorization And Lifecycle

Wire the home-manager role, configured provider/binding availability, exact dynamic targets, credential revocation, emergency stop, runtime start/stop, and cross-request approval stability.

### Task 12: Home API And OpenAPI

Add thin controllers/routes for overview, spaces, inventory, devices, bindings, provider health, refresh, safe commands, and workflow review. Validate all request boundaries and regenerate deterministic OpenAPI.

### Task 13: Home Client Store And Command Center

Add typed API helpers, Pinia state without secrets/files, overview/device/inventory panels, freshness and provider-health states, safe command confirmation, and workflow progress.

### Task 14: Migration And Compatibility

Import any prior home layout/inventory/device records idempotently into the global Twin with source provenance. Keep legacy readers operational until the new Home API has verified parity.

### Task 15: End-to-End Closure

Run fake Home Assistant browser/server flows: live event, restart replay, approval, verified command, disconnect uncertainty, credential revocation, emergency stop, and dangerous-domain rejection. Run focused suites, harness, TypeScript, build, OpenAPI determinism, and final review.

