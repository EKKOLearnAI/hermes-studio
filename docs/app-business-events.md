# Foreground App business-event subscriptions

The in-process hub in `services/webhooks/business-events.ts` is shared by HTTP
webhooks, existing social-message push and the App adapter. `observeChatRunWebhookEvent`
is the backwards-compatible producer entry; it normalizes before publishing. Group
Agent reply persistence publishes `group.message.created`; workflow socket's manager
terminal callback verifies persisted run status before publishing
`workflow.run.completed` / `workflow.run.failed`. A workflow node's chat event cannot
become a workflow-terminal or ordinary single-chat App notification.

## Wire contract v1

On the existing authenticated `/chat-run` namespace, send `app.events.subscribe`
with `{schema_version:1, profile:"default", types:[...]}`. Optional `session_ids`,
`room_ids`, `workflow_ids` narrow the subscription. Empty/omitted profile resolves
to `default` before authorization; omitted types select the supported App set.
Unknown types and malformed filters are rejected. Ack is `{ok:true,schema_version:1}`.
`app.events.unsubscribe` removes the selection. Disconnect removes the hub listener.
Reconnect must explicitly resubscribe; there is no backlog or offline delivery.

`app.event` carries `schema_version`, stable `id`, `type`, ISO `occurred_at`, `profile`,
`source`, `subject` identifiers and bounded `display` title/preview/Agent/roster fields.
Types: chat.run.completed/failed, chat.approval.requested/resolved,
chat.clarification.requested/resolved, group.message.created,
workflow.run.completed/failed. Interaction IDs remain in subject so requested and
resolved update the same UI item even though their event IDs differ.

JWT/account and current profile assignments are checked for every delivery. Group
membership/visibility is also rechecked using the existing group access policy.
Filters only narrow this authorization. Internal payloads are never sent verbatim.

## Compatibility and channels

New App sends `auth.appEventVersion=1`, subscribes on this single namespace and does
not open legacy group/workflow notification listeners. Old clients retain the three
legacy event names through a hub consumer. Version-1 clients never get both channels.
An old server rejects the new command: new App records unsupported/denied and does
not silently enable competing legacy channels. Deploy server before the App.

LAN and manual-address connections use LocalAppRelayServer; cloud uses AppRelayClient.
Both whitelist the two commands and forward the same namespace/auth/query/envelope.
No new cloud binding, endpoint, APNs, OS push, or relay event-specific transport exists.

HTTP consumers receive only the existing ChatRunWebhookEvent projection; assistant/
user body switches and schemas remain unchanged. New group/workflow event types are
not exposed as HTTP endpoint subscriptions in this change. Social push retains its
original three event types, session push flag, recipient binding and generic message
format; the new domains do not automatically expand social delivery. Consumers catch
sync/async failures independently. App ignores snapshots, old events, canceled,
interrupted and queued-continuation completions; UI preferences stay on the device.
