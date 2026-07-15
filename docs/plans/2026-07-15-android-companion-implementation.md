# Android Companion Implementation Plan

**Goal:** Implement Phase 7 as an encrypted, semantic Android execution node with durable Action Fabric commands, observations, verification, and takeover.

**Architecture:** Studio owns trust, policy, workflow, persistence, audit, and operator surfaces. The companion owns Android permissions and drivers. A dedicated encrypted protocol connects them; generic LAN peer primitives are outside the authority boundary.

## Time-boxed Delivery

- Batch A — trust and protocol foundation: Tasks 1-4.
- Batch B — semantic node and observations: Tasks 5-7.
- Batch C — governed execution and takeover: Tasks 8-11.
- Batch D — product surface and closure: Tasks 12-15.

Each task starts with focused failing coverage, implements the smallest durable contract, runs relevant TypeScript/tests, and commits only its files.

### Task 1: First-Class Android Executor Type

Upgrade Action Fabric types, constrained SQLite schema, registry, runtime external-write/interrupt classification, API/OpenAPI enums, client labels, and upgrade/reopen tests for `android`.

### Task 2: Additive Device Exchange Identity

Extend the existing Ed25519 identity file with X25519 exchange keys without changing the stable device ID. Enforce key validation, owner-only persistence, concurrent initialization safety, legacy upgrade, and public-info redaction tests.

### Task 3: Companion Contracts And Database

Add bounded types and a dedicated SQLite store for paired devices, public trust material, capability reports, permissions, durable commands, receipts, notification observations, artifact metadata, takeovers, and monotonic counters. Enforce legal transitions, canonical digests, replay identity, and secret-free persistence.

### Task 4: Pairing And Encrypted Session Primitives

Implement one-time enrollment challenges, signed pairing transcripts, ephemeral X25519 handshake, HKDF directional keys, AES-256-GCM envelopes, authenticated metadata, monotonic sequence enforcement, expiry, tamper/replay rejection, and deterministic crypto vectors for a virtual companion.

### Task 5: Companion Gateway Lifecycle

Add the dedicated WebSocket upgrade manager, authenticated pairing endpoints, bounded connection/session registry, heartbeat, durable acknowledgement, reconnect/backoff, revocation disconnect, and clean server shutdown. Keep plaintext and generic peer messages outside the channel.

### Task 6: Semantic Capability And Permission Reports

Define the server allowlist, validate device reports, intersect driver/package/permission health, register only exact semantic capability bindings, and revoke stale or missing bindings. Reject taps, coordinates, selectors, scripts, arbitrary intents, URLs, and shell actions.

### Task 7: Notification Observation And Twin Projection

Ingest encrypted notification observations with package policies, OTP/secret/health/finance minimization, size limits, sequence replay protection, idempotent removal, Personal Twin events, and outbox deduplication.

### Task 8: Durable Companion Command Bridge

Implement workflow-bound command creation, encrypted delivery, device acknowledgement, bounded response validation, cancellation, offline retry classification, restart replay, and terminal-receipt reuse. Never place transport keys or raw driver steps in Action Fabric evidence.

### Task 9: Semantic Android Action Fabric Adapter

Register the initial `android.app.launch` and `android.screen.capture` contracts and exact device/app targets. Implement prepare, execute, fresh verification, interrupt, receipts, stable errors, role authorization, and production runtime lifecycle.

### Task 10: Screen Artifact Boundary

Require an explicit active screen-capture permission grant, validate dimensions/age/digest, encrypt artifacts at rest, serve only authenticated bounded metadata by default, and prevent screenshot bytes or local paths from reaching audit, API lists, or model context.

### Task 11: Same-Workflow Takeover And Recovery

Persist challenge, login, biometric, permission, and layout-change takeovers. Bind claims/completions to workflow, device, command, and generation; resume the same workflow at verification; reject stale or unrelated completion; cover Windows/device restart and revocation.

### Task 12: Android Companion API And OpenAPI

Add thin authenticated controllers/routes for overview, pairing approval/revocation, devices, capability health, commands, receipts, notifications, artifacts, and takeovers. Keep enrollment endpoints narrowly unauthenticated but code/signature/rate-limit protected. Regenerate strict deterministic OpenAPI.

### Task 13: Android Companion Client Surface

Add typed API helpers, Pinia state, Personal OS route, device/trust/status panels, capability and permission health, observation counters, active workflow/takeover controls, artifact metadata, revocation, all-locale messages, and mocked browser-flow coverage.

### Task 14: Security And Compatibility Closure

Harden audit/API redaction, peer-versus-companion authority separation, pairing throttling, origin/upgrade checks, key rotation behavior, command bounds, emergency stop, existing Devices UI compatibility, and Agent Bridge documentation where execution flow changes.

### Task 15: End-to-End Closure

Use the virtual companion to prove pairing, encrypted session, capability report, notification projection, semantic launch, fresh verification, restart replay, capture permission, takeover/resume, tamper/replay rejection, revocation, offline recovery, and emergency stop. Run focused suites, browser tests, harness, TypeScript, build, OpenAPI determinism, and final review.

## Completion (2026-07-15)

Tasks 1-15 are complete for the Studio/server scope defined by this plan. Native Android packaging, signing, and distribution remain a separate release concern rather than an authority granted to Studio.

The closure baseline is 21 focused test files with 83 passing tests, clean server and Vue TypeScript checks, deterministic OpenAPI generation (304 endpoints and 45 tags), a successful production build, and a passing repository harness.
