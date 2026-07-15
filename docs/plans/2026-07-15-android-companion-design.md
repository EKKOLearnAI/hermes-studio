# Android Companion Design

Date: 2026-07-15
Owner: User + Codex
Status: Approved

## Goal

Phase 7 turns a self-owned Android phone into a least-privilege Action Fabric execution node. Hermes Studio remains the authority for policy, durable workflow state, audit, revocation, and takeover; the companion owns Android permissions, Android Keystore keys, app drivers, accessibility execution, notification observation, screen capture, and the on-device takeover surface.

```text
semantic Action Intent
  -> exact Android capability and paired device target
  -> Action Fabric policy and durable workflow
  -> encrypted companion command with stable workflow identity
  -> companion-owned deterministic app driver
  -> bounded result plus fresh device-side verification
  -> durable receipt, audit, Twin event, or human takeover
```

## Delivery Boundary

This repository owns the Studio/server protocol, persistence, Action Fabric adapter, APIs, operator UI, and a protocol-conformant virtual companion used for deterministic integration tests. The native Android artifact consumes the same frozen wire contract and keeps private keys in Android Keystore; APK signing and store/distribution work are separate release concerns.

The current generic LAN peer socket is not reused for Android execution. It authenticates signed peers but may carry plaintext traffic on HTTP and exposes terminal and file primitives. Phase 7 reuses only the existing device identity and approval concepts, with a separate encrypted, semantic-only companion channel.

## Decisions

- Add first-class `android` Action Fabric executors. They are external executors, interruptible when the device confirms cancellation, and disabled by level-three emergency stop.
- Extend Studio device identity with an X25519 exchange key while preserving the current Ed25519 signing identity and device ID.
- Pairing requires an authenticated Studio user, a bounded one-time code, proof of both device identities, and an explicit local approval. Pairing codes and derived session keys are never persisted.
- Every connection performs a signed ephemeral X25519 handshake. HKDF-SHA256 derives directional AES-256-GCM keys bound to the protocol version, both device identities, the session ID, and handshake transcript.
- Encrypted envelopes use monotonically increasing directional sequence numbers, authenticated metadata, bounded payloads, expiry, and replay rejection. Revocation closes active sessions and prevents new handshakes.
- The companion reports semantic capabilities from a server allowlist. Raw taps, coordinates, selectors, accessibility node IDs, arbitrary intents, shell commands, URLs, and scripts are never Action Fabric capabilities.
- Initial low-risk proof capabilities are `android.app.launch` and `android.screen.capture`. Launch targets an exact server-approved package binding; screen capture requires an active MediaProjection-style grant and persists only a bounded encrypted artifact reference plus digest.
- Notifications are observations, not executable commands. Only allowlisted package metadata and bounded redacted text enter the Twin; notification actions are deferred until a domain contract defines exact semantics.
- A challenge, login, biometric prompt, missing permission, changed layout, or uncertain result moves the same workflow to takeover. The companion never attempts to bypass CAPTCHA, SMS, fingerprint, face, or device credential verification.
- Existing LAN pairing, remote terminal, and file-transfer behavior remains compatible and cannot authorize companion execution.

## Trust And Pairing

Studio keeps its Ed25519 signing key and an additive X25519 exchange key under Web UI state with owner-only permissions. The Android companion keeps both private keys in Android Keystore.

Pairing binds:

- Studio and companion signing public keys and derived device IDs;
- Studio and companion exchange public keys;
- protocol version and companion installation ID;
- user-approved device label;
- an initial capability-report digest;
- the one-time pairing challenge and expiry.

The companion signs the enrollment transcript. Studio verifies the signature, pairing challenge, expiry, device-ID derivation, key formats, and local approval before storing public trust material. Key rotation creates a new approval event; it never silently replaces a trusted key.

## Encrypted Session Protocol

The companion connects to a dedicated WebSocket upgrade path and sends a signed `session.hello` containing its paired device ID, ephemeral exchange key, nonce, timestamp, and last acknowledged durable command sequence. Studio returns a signed ephemeral response. Both sides derive independent send and receive keys and nonce prefixes.

After the handshake, plaintext JSON is rejected. Each encrypted envelope authenticates:

```text
protocol version
session ID
sender and recipient device IDs
direction
sequence number
message type
workflow or observation identity
ciphertext length
```

Supported message families are deliberately narrow:

- `capabilities.report` and `permissions.report`
- `notification.observed` and `notification.removed`
- `command.execute`, `command.result`, and `command.cancel`
- `screen.capture.request` and `screen.capture.result`
- `takeover.requested`, `takeover.claimed`, and `takeover.completed`
- `heartbeat` and durable acknowledgements

Unknown types, gaps outside the bounded replay window, duplicate sequence numbers, expired commands, oversized ciphertext, invalid AEAD tags, and mismatched workflow/device bindings close the session fail-closed.

## Persistence

Global companion state lives in a dedicated SQLite database under the Personal OS data root. It stores only public keys, fingerprints, approval/revocation state, capability and permission summaries, monotonic counters, durable command metadata, sanitized receipts, notification observations, takeover state, and encrypted artifact references.

It never stores pairing codes, private keys, session keys, AEAD nonces for reuse, raw accessibility trees, full screenshots in SQLite, notification action tokens, account credentials, or Android Keystore aliases exposed through APIs.

Durable commands are keyed by workflow and execution token. Re-delivery after Studio or phone restart uses the same command identity. A terminal receipt replays without another device effect. Material contract, target, device, or capability changes invalidate replay.

## Semantic Capability Model

Companion reports include exact capability ID/version, app package fingerprint, driver version, permissions, environment, risk support, verification method, and health. Studio intersects that report with its own allowlisted contracts before registering an executor binding.

`android.app.launch` accepts a server-resolved app binding, not an arbitrary package from an agent. Verification asks the companion for a fresh foreground-app observation and requires the expected package fingerprint.

`android.screen.capture` accepts a workflow reason and bounded capture class, not crop coordinates or file paths. Verification checks a fresh capture ID, digest, dimensions, age, permission grant, and device/workflow binding. The raw artifact is encrypted at rest and is not copied into normal audit or model context.

Future food-delivery, Taobao, calendar, communication, and entertainment drivers register their own semantic contracts. They may use accessibility internally, but roles never receive a generic accessibility capability.

## Notifications And Twin Projection

Notification observations are deduplicated by device, package, Android notification key hash, post time, and source sequence. The default persisted projection contains package binding, category, channel hash, bounded title/text summary, visibility, posted/removed timestamps, and provenance.

Sensitive, secret-shaped, OTP, authentication, banking, health, or hidden notification content is reduced to metadata unless an explicit package policy permits a task-scoped view. Replayed events update provenance without duplicating Twin events or outbox rows.

## Takeover

A takeover record is bound to the original workflow, device, semantic capability, current command, and policy snapshot. Studio shows the reason and a device route, while the phone shows the local task context. Neither surface exposes credentials or raw accessibility data.

After the user finishes the challenge, the companion sends a signed encrypted completion bound to the takeover generation. Action Fabric resumes the same durable workflow at verification. Stale, duplicated, revoked-device, or unrelated completions are rejected.

## Studio Surface

The Android Companion command center shows paired/revoked devices, encrypted session health, capability and permission summaries, notification ingestion status, active commands, receipts, artifact metadata, takeover tasks, and emergency-stop state.

It does not show private keys, session keys, pairing codes after enrollment, raw accessibility trees, notification action tokens, complete screenshots by default, or arbitrary command controls.

## Acceptance Criteria

- Action Fabric persists and validates an `android` executor through schema upgrade and reopen.
- Existing Ed25519 device identities upgrade additively with a stable X25519 public identity.
- A virtual companion completes pairing and a signed ephemeral handshake, then exchanges only authenticated encrypted envelopes.
- Ciphertext replay, reordering, expiry, tampering, wrong-device routing, key substitution, and post-revocation reconnect all fail closed.
- Capability reports cannot register raw UI primitives or unknown app bindings.
- A semantic app launch executes once, survives process/adapter restart, verifies from a fresh foreground observation, and produces a durable receipt and audit trail.
- Notification replay is idempotent and projects only policy-minimized data into Personal Twin.
- Screen capture requires explicit permission, stores only an encrypted artifact reference and bounded metadata, and never leaks raw content into audit/API responses.
- A challenge creates a device and Studio takeover task; completion resumes the same workflow at verification.
- Offline, revoked, permission-missing, contract-changed, and emergency-stop states prevent new Android work.
- Existing LAN pairing and peer tools continue to pass compatibility tests without gaining companion authority.
