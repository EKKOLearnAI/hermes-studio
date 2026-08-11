# App Relay Host

App Relay lets a separately developed mobile App reach one Hermes Web UI
machine without exposing that machine directly to the Internet. It is separate
from the MCU `/global-agent` connection and never starts or stops with an MCU
remote connection.

## Local management API

These endpoints use the normal Hermes Web UI user authentication:

- `GET /api/app-relay/status`
- `POST /api/app-relay/connect`
- `POST /api/app-relay/pairing-code`
- `POST /api/app-relay/disconnect`

Connecting authenticates this machine to the independent
`config.appRelay.url` endpoint with the existing Ed25519 machine identity.
Development uses `http://127.0.0.1:8077`; production uses
`https://api.hermes-studio.ai`. The address cannot be overridden at runtime.
The connect and pairing responses include an eight-character pairing code that
expires after ten minutes. Enter that code in the App to bind the cloud App
account to this machine.

## Forwarded protocols

- HTTP RPC accepts local Web UI `/api/**`, `/upload`, and `/health` paths.
- Request headers are allowlisted. Hop-by-hop and host headers are not forwarded.
- Request and response bodies are capped at 20 MiB and binary bodies use base64.
- Socket RPC only accepts the `/chat-run` Socket.IO namespace.
- Chat client events are allowlisted to run, resume, abort, queue cancellation,
  approval responses, and clarification responses.
- All server-emitted `/chat-run` events are forwarded, including future event
  additions that do not require a Relay update.
- Every App socket bridge has a relay-owned ID. Events cannot be sent to a
  bridge owned by another App connection.

The cloud App access token authorizes access to a paired machine. Calls to the
local Web UI still carry a local Hermes user token, so the normal local user and
profile permissions remain authoritative.

## LAN App Relay server

Hermes Studio also serves the App-facing Socket.IO protocol at `/app-relay` on
its own HTTP origin. The App uses the same `http.request`, `socket.open`,
`socket.event`, and `socket.close` events and receives the same response shapes
whether it connects to the cloud relay or directly to a Studio machine.

The transport paths differ only after the App-facing server accepts a request:

- Cloud: App -> cloud Relay server -> Studio Relay client -> local HTTP or
  `/chat-run`.
- LAN: App -> Studio Relay server -> local HTTP or `/chat-run`.

The LAN path does not start or call an App Relay client. The App first connects
with the selected machine ID. An unauthenticated connection may only send a
`POST /api/auth/login` through `http.request`; after a successful response the
same Socket.IO connection is promoted with the returned local Hermes user token.
All later loopback requests and chat sockets use that token. The public
`/api/devices/link-info` response advertises this capability as:

```json
{
  "app_relay": {
    "protocol": "socket.io",
    "namespace": "/app-relay",
    "direct": true
  }
}
```
