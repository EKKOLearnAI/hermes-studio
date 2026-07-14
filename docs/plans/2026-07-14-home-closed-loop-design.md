# Home Closed Loop Design

## Goal

Phase 5 turns the Home and Assets domain into a first-party Personal Twin domain pack. Home Assistant is the first physical-control adapter, while Hermes Studio remains the canonical semantic model and Action Fabric remains the only write path for device commands.

The closed loop is:

```text
Home Assistant state/event
  -> normalized provider event
  -> Home Twin device, binding, state, room, object, and inventory facts
  -> projection/rule evaluation
  -> semantic Action Fabric intent
  -> bounded device command
  -> observed state verification
  -> durable audit and Twin outcome
```

## Decisions

- Use the global `personal/twin.db`; do not revive the old profile-scoped `home_state.db` as a second source of truth.
- Add normalized Home tables for high-integrity provider identities, device state, inventory quantities, subscriptions, and execution ledgers. Mirror meaningful changes into generic Twin entities, relations, observations, events, and outbox.
- Bootstrap Home Assistant with REST state discovery, then use its WebSocket API for live `state_changed` events. Polling is only a bounded recovery fallback.
- Keep Home Assistant credentials in the selected Hermes profile configuration or environment. Twin rows and Action Fabric audit store only credential fingerprints and sanitized provider health.
- Register semantic capabilities such as `home.device.set_power` and `home.device.set_level`; never expose arbitrary service names as role-callable capabilities.
- Phase 5 permits only an explicit safe domain allowlist. Locks, garage doors, alarms, cameras, security systems, firmware updates, arbitrary scripts, and destructive services stay denied.
- Commands are idempotent where provider semantics permit it and are successful only after a matching observed state event or bounded read-back verification.
- Event ordering uses provider timestamps plus a stable provider event identity. Duplicate and stale events must not regress state.

## Domain Model

- `HomeSpace`: home, floor, room, zone, furniture, compartment, or surface.
- `HomeObject`: a semantic physical object or asset placed in a space.
- `HomeInventoryItem`: quantity-bearing stock with append-only adjustments.
- `HomeDevice`: provider-independent device identity, class, availability, and space placement.
- `HomeDeviceBinding`: exact `(provider, external_id)` mapping plus normalized capabilities.
- `HomeDeviceState`: latest value for one normalized state key with source event identity and observation time.
- `HomeProviderEvent`: immutable normalized input event and processing outcome.
- `HomeProviderCursor`: durable subscription/session recovery state without credentials.
- `HomeCommandReceipt`: exact provider request identity and verified result bound to an Action Fabric execution token.

## Home Assistant Adapter

The adapter has four boundaries:

1. A strict configuration resolver validates base URL, token availability, timeouts, TLS policy, and profile scope.
2. A protocol client performs authenticated REST bootstrap and WebSocket auth/subscription with message and byte limits.
3. A normalizer converts only allowlisted Home Assistant entity domains and attributes into Home Twin contracts.
4. A runtime supervisor reconnects with bounded backoff, resumes subscription, deduplicates events, and exposes sanitized health.

## Action Fabric Capabilities

Initial safe capabilities:

- `home.device.refresh`
- `home.device.set_power`
- `home.device.set_level`
- `home.device.set_temperature`
- `home.scene.activate.safe`

Targets are exact atoms:

```text
home:provider:home-assistant
home:device:<device-id>
home:binding:home-assistant:<external-id>
```

Power and level changes are low risk but irreversible at the Action Fabric contract level, so they require user approval until a later stability policy explicitly grants bounded standing authority. Temperature changes are medium risk and always approval-gated in Phase 5.

## Verification

A command verifies only when the observed provider state matches the normalized postcondition within the deadline. A timeout, unavailable entity, ambiguous service response, or disconnect produces `unknown`/review rather than blind retry. Execution tokens, provider request IDs, expected state, observed event IDs, and final evidence are durable.

## Studio Surface

The Home command center provides:

- provider connection and subscription health;
- rooms, devices, bindings, freshness, and availability;
- inventory warnings and recent provider events;
- safe manual controls that create Action Fabric workflows;
- waiting, failed, and verified home actions with evidence;
- an emergency-stop explanation when external writes are disabled.

## Acceptance Criteria

- A Home Assistant `state_changed` event updates one exact device state once and writes a Twin event/outbox record.
- Restart and replay do not duplicate provider events or regress newer state.
- Rooms, objects, inventory, devices, capabilities, state, and bindings are queryable from the Home domain pack.
- A safe power command enters Action Fabric, requires the expected approval, executes through the exact binding, and verifies from observed state.
- Credential revocation or emergency stop prevents new external writes.
- Dangerous Home Assistant domains and arbitrary services cannot be invoked through the semantic API.
- The browser shows provider health, live state freshness, approvals, and verification without exposing credentials.

