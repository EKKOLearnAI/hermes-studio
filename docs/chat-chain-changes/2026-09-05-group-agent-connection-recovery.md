# Group Agent connection isolation and recovery

Group Agent sockets now use their own Socket.IO manager. Previously the first
Agent could share a cached manager with an App relay namespace on the same local
server. Closing that relay with `disconnect(true)` disconnected the Agent too,
with `io server disconnect`, which does not automatically reconnect. Additional
Agents could remain online because repeated connections to the same namespace
already received separate managers. Offline Agents are excluded from mention
dispatch, so subsequent mentions produced no execution task.

Room rejoin now runs on the namespace socket's `connect` event. The manager's
`reconnect` event happens before namespace authentication completes, so the old
handler attempted to join while `connected` was still false. Disconnect logs now
include the Agent ID, reason, and whether automatic reconnect remains active.

Real Socket.IO regression tests cover two local Agents plus a relay transport
closure, and repeated transport reconnects with restored room membership. Both
failure paths were reproduced before the fix. The reported room history showed
unanswered mentions of the first local Agent; historical logs did not capture its
exact disconnect reason, so the incident trigger cannot be proven retrospectively.

This changes Studio group Agent connections only. Cloud relay, single-chat
transport, credentials, and message persistence are unchanged. Existing running
Studio processes need to load the update to use isolated connections.
