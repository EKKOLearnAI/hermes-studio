# Durable Outbound Event Outbox

Hermes Studio can tell another system when something finished. A run completes,
a job fails, an approval is waiting — Studio records that as an event and
delivers it to the webhook endpoints you configured, retrying until it lands.

**The feature is opt-in and silent by default.** With no endpoint configured,
nothing is recorded for delivery and no request leaves the instance.

## Why an outbox rather than a plain webhook call

A webhook fired inline is lost the moment the receiver is down or Studio
restarts mid-request. Here the event is written to SQLite first, in the same
transaction as the change it describes, and a background dispatcher drains the
queue afterwards. Studio can restart in the middle of a delivery and the
delivery resumes; the receiver can be offline for an hour and still get its
events.

The event and its deliveries are separate tables, so one event can go to several
endpoints and each keeps its own attempt count.

## Events

| Type | Fires when |
| --- | --- |
| `chat.run.completed` | a chat run finishes, after the result is saved |
| `chat.run.failed` | a chat run ends with an error |
| `chat.approval.requested` | the agent asks for a tool approval |
| `chat.clarification.requested` | the agent asks the user a question |
| `group.run.completed` / `group.run.failed` | a group-chat agent turn ends |
| `group.message.created` | a message is posted in a room |
| `cron.run.completed` / `cron.run.failed` | a scheduled job finishes |
| `workflow.run.completed` / `workflow.run.failed` | a workflow run ends |

Nothing is published before the corresponding result is persisted, so a receiver
reacting to `completed` can immediately read the record over the API.

## The envelope

```json
{
  "schema_version": 1,
  "id": "8f14e45fceea167a5a36dedd4bea2543",
  "type": "chat.run.completed",
  "occurred_at": "2026-08-08T09:21:44.000Z",
  "profile": "work",
  "source": "chat",
  "subject": { "session_id": "ms8f2k", "run_id": "run_41" },
  "summary": { "status": "completed", "input_tokens": 1840, "output_tokens": 260 }
}
```

`id` is stable: it is derived from the event's dedupe key, so a replayed or
retried run maps to the same id and a receiver can deduplicate on it alone.

**The payload never carries conversation content.** `subject` holds identifiers
and `summary` holds status, counts and durations. A receiver that needs the text
asks the API for it with its own credentials — a leaked webhook URL does not leak
what anyone said.

## Signing

When an endpoint has a secret, every request carries:

```
X-Hermes-Event:         chat.run.completed
X-Hermes-Delivery:      c39b1e04-...
X-Hermes-Timestamp:     1786112504
X-Hermes-Signature-256: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, timestamp + "." + rawBody)`. Verify the
timestamp is recent before comparing, and compare in constant time.

The secret can be stored in Studio or, if you would rather keep it out of the
database, named with `secret_env` and read from that environment variable at
delivery time. Either way the API never returns it — endpoints report only
`has_secret`.

## Delivery rules

- `2xx` is success. Everything else fails.
- Network errors, `408`, `429` and `5xx` are retried; other 4xx are permanent.
- Exponential backoff with full jitter, from 5 seconds up to one hour.
- Redirects are never followed — a signed payload must not be forwarded to a
  host you did not name.
- Requests time out after 10 seconds, and at most 64 KB of the response is read.
- After `max_attempts` (8 by default) the delivery is marked `dead` and kept for
  inspection instead of being retried forever.

## Configuring an endpoint

```bash
curl -X POST https://studio.example.com/api/hermes/webhooks/endpoints \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "ops-bot",
    "url": "https://ops.example.com/hermes",
    "secret": "a-long-random-string",
    "event_types": ["chat.run.failed", "cron.run.failed"],
    "profiles": ["work"]
  }'
```

Empty `event_types` or `profiles` means "everything". Managing endpoints requires
a super-admin; `GET /api/hermes/capabilities` is available to any authenticated
user so a client can discover whether this Studio supports the outbox:

```json
{ "capabilities": { "event_outbox": { "enabled": true, "schema_version": 1, "event_types": ["..."], "endpoint_count": 1, "pending_deliveries": 0 } } }
```

Other endpoints: `PATCH /:id`, `DELETE /:id`, `PUT /:id/enabled`,
`POST /:id/test` (sends one synthetic event without recording it), and
`GET /:id/deliveries` for recent delivery status.

## A receiver, in full

```js
import express from 'express'
import { createHmac, timingSafeEqual } from 'crypto'

const SECRET = process.env.HERMES_WEBHOOK_SECRET
const app = express()

app.post('/hermes', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.get('X-Hermes-Timestamp') || ''
  const signature = req.get('X-Hermes-Signature-256') || ''
  const rawBody = req.body.toString('utf8')

  // Reject anything older than five minutes before comparing digests.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return res.sendStatus(400)

  const expected = 'sha256=' + createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.sendStatus(401)

  const event = JSON.parse(rawBody)
  // Deliveries can repeat after a retry; `event.id` is stable, so dedupe on it.
  if (alreadyHandled(event.id)) return res.sendStatus(200)
  handle(event)

  // Answer quickly: slow receivers are retried, not waited on.
  res.sendStatus(204)
})
```

Answer `2xx` as soon as you have durably accepted the event and do the work
afterwards. If you need to be re-sent an event, answer `5xx` and it will come
back on the next backoff.
