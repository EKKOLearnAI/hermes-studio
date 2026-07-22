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
The same origin serves App account APIs and the Relay namespace. The connect and pairing responses include an
eight-character pairing code that expires after ten minutes. Enter that code in
the App to bind the cloud App account to this machine.

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

## APP account gate

The `/hermes/app` page restores a central APP account session before showing
connection or pairing controls. Signed-out users can:

- request a six-digit email code and register with email, password, and code;
- sign in with email and password.

Email verification is delivered by the central server through its configured
163 SMTP account. The mailbox authorization code never reaches Hermes Web UI.
