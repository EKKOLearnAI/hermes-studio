# App connection relay

App Relay lets the mobile App reach a Hermes Studio instance without exposing
the Studio HTTP server to the Internet. It is independent from the MCU
`/global-agent` connection.

Studio can use the official `https://api.hermes-studio.ai` route or the
Cloudflare `https://cn.hermes-studio.ai` route. The selected route is persisted
locally and included in cloud QR codes as informational metadata. The App keeps
an independent route setting; scanning a cloud QR never changes it.

## LAN authorization

An authenticated Studio user creates a one-time LAN QR code through
`POST /api/app-connections/authorization-codes/lan`. The QR contains the local
backend URL, machine ID, a high-entropy authorization code, and its expiry. It
expires after five minutes, is stored only as a hash, records the user who
created it, and can be consumed once.

The App exchanges it through `POST /api/auth/app-login` together with its
stable installation device code, device name, brand, and model. Studio issues
a device-bound `app_access` token for the authorizing Studio user. App tokens
use the `hermes-studio` audience and expire after 30 days. Manual LAN login may
use an active Studio username and password instead of an authorization code.

## Cloud preconnection and claim

An authenticated Studio user creates a cloud QR through
`POST /api/app-connections/authorization-codes/cloud`. Studio first signs into
the cloud `/app-relay` namespace with its Ed25519 machine identity, then asks
the cloud for a preconnection. The QR contains only:

```json
{
  "t": "hsac",
  "v": 1,
  "c": "cloud",
  "m": "hwui_...",
  "p": "uuid",
  "k": "high-entropy secret",
  "e": 0,
  "r": "official"
}
```

The compact keys represent type, version, connection type, machine ID,
preconnection ID, matching code, expiry, and Studio network route respectively. Compact encoding
reduces QR density without reducing matching-code entropy. The matching code
expires after five minutes. Refresh has a ten-second
cooldown and is limited to three times for a preconnection; every successful
refresh invalidates the previous matching code. An unmatched host connection
has an absolute 15-minute lifetime and is actively disconnected by the cloud.
The Studio UI never automatically refreshes an expired LAN or cloud QR: it
keeps the QR visible with an expired overlay until the user requests refresh.

The signed-in App sends the QR fields and its stable device identity to
`POST /api/app/connections/claim`. The cloud asks that exact Studio socket to
exchange the Studio-side one-time authorization code. Only after both sides
succeed does the cloud create or reactivate the formal connection.

## Cloud data model and isolation

The cloud stores physical phone installations in `app_device` and formal
phone-to-Studio relationships in `app_device_connection`. A formal connection
is unique by `(appDeviceId, machineId)`, allowing one Studio to connect to many
phones and one phone to connect to many Studios. A device code is globally
bound to one App account.

Account limits are checked through dedicated entitlement hooks. They currently
return unlimited values; subscription or plan limits can later be added without
changing the connection tables or claim protocol. Physical-device limits must
count `app_device`, not connection rows.

Cloud App sockets require three independent credentials:

- the App account access token;
- the formal `connectionId` and App device code;
- a random per-connection credential, stored only as a hash in the cloud.

The cloud derives `machineId` from the formal connection row instead of trusting
the App handshake. The local Studio user token remains separate and continues
to enforce normal Studio user/profile permissions on forwarded requests.

## Presence, deletion, and restart

`GET /api/app-connections` reports live LAN presence from the local relay and
live cloud App presence from the cloud connection pool. Studio polls this list
while the page is visible.

The App uses `GET /api/app/connections/:connectionId/status` for an individual
cloud connection. The cloud verifies that the connection belongs to the
authenticated account, then reads `machineOnline` from the Studio host socket
pool and `appOnline` from the formal App-connection socket pool. Socket.IO
heartbeat loss removes the corresponding socket from the pool. The response is
not cacheable and also returns the Hermes Agent and Hermes Web UI versions from
the machine's latest signed registration metadata. This is a presence lookup,
not a new inbound request to the Studio machine.

Deleting a Studio connection creates a local revocation tombstone. LAN Apps are
notified and disconnected directly. Cloud deletions revoke the formal cloud
connection and disconnect its socket. An offline App is rejected with
`app_connection_deleted` on its next connection and removes the device after
showing a confirmation dialog.

If Studio has any active cloud App records, it connects to the cloud at startup.
Socket.IO reconnects indefinitely after transient disconnects. The cloud
restores the formal-connection snapshot; Studio reconciles it against local
revocation tombstones so an offline cloud deletion is eventually propagated.
Development Web UI hosts use a separate persistent Ed25519 identity and also
register as non-preemptive. Starting `npm run dev` therefore creates a distinct
Web endpoint instead of replacing the packaged desktop socket or overwriting its
machine metadata. Packaged production builds keep the legacy machine identity,
so existing desktop connections remain compatible. Production hosts retain the
existing takeover behavior so a restarted desktop can recover stale connections.

## Forwarded protocols

- HTTP RPC accepts Studio `/api/**` and `/health` paths.
- Request headers, methods, paths, and Socket.IO client events are allowlisted.
- Request and response bodies are capped at 20 MiB.
- Socket RPC accepts `/chat-run` and `/group-chat` only.
- Every bridge is bound to one formal App connection and one host socket.
- Formal connection authorization is rechecked before each forwarded request.

LAN and cloud use the same App-facing RPC event shapes. Their transport paths
are:

- LAN: App → Studio local relay → local HTTP or Socket.IO.
- Cloud: App → cloud relay → signed Studio host socket → local HTTP or
  Socket.IO.

## Cloud observability

The cloud writes structured JSON operational logs to stdout. Authentication
material, passwords, matching codes, authorization codes, and connection
credentials are redacted. Critical App-connection lifecycle events are also
stored in `app_connection_audit_log`; device codes are stored there only as
SHA-256 hashes.

Audit rows default to a 30-day retention period and a maximum of 1,000,000
rows. Cleanup runs at startup, every six hours, and after each 1,000 new audit
records, deleting in bounded batches. Super administrators can query the audit
history through `/admin/appConnectionAudit/getList`. Retention and row limits
can be adjusted with `APP_AUDIT_RETENTION_DAYS` and `APP_AUDIT_MAX_ROWS`.
