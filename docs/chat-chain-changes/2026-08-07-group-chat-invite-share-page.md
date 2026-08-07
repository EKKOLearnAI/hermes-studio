---
date: 2026-08-07
pr: pending
feature: Invite-only group chat share page
impact: Group chat rooms can now be opened through a standalone invite link without a Web UI account, while the invited socket is scoped to one room and cannot perform room-management actions.
---

The share route reuses the existing realtime message flow without loading the
application or room sidebars. Invite guests authenticate during the Socket.IO
handshake, load older history through their joined socket, and use text chat
without access to protected workspace or management APIs.

Links that already contain an invite code render a neutral loading surface
while the code is resolved, so the manual invite form does not flash before the
room opens. The form remains available for missing or invalid codes.

Invite guests can send messages to room Agents through explicit `@Agent`
mentions. Clicking an Agent avatar inserts its mention for read-only viewers,
while management, workspace, interruption, and approval actions remain
restricted to room managers. The `@all` option is shown only to the persisted
room owner and is independently enforced by the server; profile-derived
managers, invite guests, and Agents cannot submit it.

Before connecting, invite guests must confirm a display name. Participant names
are unique within a room across both humans and Agents, using normalized,
case-insensitive comparison; reconnecting participants may keep or change their
own name as long as it does not conflict. The reserved `all` name remains
unavailable because it is the room-wide mention token.

Guests can choose a generated avatar or upload a PNG, JPEG, or WebP avatar
before joining. The validated avatar is stored only on the room member record
and in the browser's group-chat identity storage; it is not written to the Web
UI account avatar table. Account avatars are resolved only through exact
authenticated user IDs, so choosing an account's display name cannot expose
that account's avatar.

Guest identity uses the browser-persisted group-chat UUID for navigation,
refresh, and Socket.IO reconnects, including transitions from an authenticated
group-chat session. The standalone view also suppresses input settings,
autoplay speech, and per-message speech controls.

Both authenticated and invite-only group chat attachments use dedicated room
endpoints instead of the system `/upload` and generic download APIs. Files are
stored under a hashed room directory in
`HERMES_WEB_UI_HOME/group-chat/attachments`, with a 20 MB request limit, a
500 MB per-room quota, serialized writes, random non-overwriting filenames,
and a per-room upload rate limit. Invite attachment reads revalidate the
current invite code on every request, reject cross-room names and traversal,
disable caching, and remove the directory when the room is deleted.

Upload responses expose only an opaque stored filename, not the server's Web UI
home path. Human Socket.IO messages cannot nominate local filesystem paths:
array and JSON-encoded attachment blocks are both validated, rebound to an
existing regular file in the current room attachment directory, and only then
expanded to an absolute path for the Agent runtime. Human clients also cannot
spoof Agent roles or tool/reasoning metadata.

Historical system uploads and images explicitly published by a room Agent are
never served from their original paths to invite guests. After the message and
Agent identity are verified, the server copies the image into that room's
attachment directory and serves only the isolated copy. Unpublished paths,
non-Agent external paths, symlinks, and files from other rooms remain
inaccessible.

An invite handshake is always validated and scoped to its resolved room,
including deployments where account authentication is disabled. The public
invite resolver returns only the room identity and inert UI defaults; provider,
model, workspace, token, and management metadata remain private.

For an Internet-facing deployment, account authentication must remain enabled
so the invite routes are the only unauthenticated surface. Disabling global Web
UI authentication intentionally makes the rest of the Web UI API public as
well; an invite code cannot restore an authorization boundary that the global
deployment configuration has removed.

Room Agent creation, edits, and removal now broadcast the complete Agent roster
to every connected room client. Stores replace their current-room roster from
that event, so other browsers and invite-only viewers update without refreshing.
The Agent owner member ID is visible so clients can render the owner's existing
room-member avatar. Server-local Agents are attributed to the persisted room
owner, and remote Agents to the member who connected them. Connector IDs and
target origins remain omitted from the room-wide roster: room managers receive
no connector metadata for other members' Agents, while each member receives
those fields only for remote Agents they own.

Human avatars are ordered with the persisted room owner first, the current
viewer second, and remaining members by join time. Only the room owner can
remove a human member. Removal immediately evicts that member from the live
room and also revokes and removes any remote Agents the member brought in.
Because this is a room removal rather than a permanent identity ban, the member
can join again while the invite code remains valid.

New room, clone, and rotation actions generate 16-character invite codes with
cryptographically secure random bytes and an alphabet that omits ambiguous
characters. Existing and manually entered shorter codes remain valid.

Invite guests may also bring an Agent from their own Hermes Web UI into a room
when the room owner enables the policy and approves the individual request.
The share page performs a best-effort probe of local ports 8648 and 8748 while
retaining manual local, LAN, and remote service URLs. Authorization happens in
the target Web UI's protected
`/?groupChatAgentLink=1#/group-chat-link` page, so an HTTPS share page does not
need to make a mixed-content credentialed request to an HTTP service on
localhost. Only that exact root-document marker receives
`Cross-Origin-Opener-Policy: unsafe-none`; all other documents retain the
baseline opener isolation policy.

In the Electron desktop app, the dedicated Agent authorization route opens as
a native child window for both local and remote targets. The child is sandboxed,
has no Node integration or desktop preload, and is allowed only for the exact
`/?groupChatAgentLink=1#/group-chat-link` route and frame name. Other remote
links continue to open in the system browser.

New connection requests do not depend on `window.opener` surviving a
cross-origin navigation. The invite page first creates a short-lived draft
handoff with client-generated request credentials. After the user selects an
Agent, the authenticated target service submits the descriptor directly to the
fixed cloud invite endpoint, keeps an in-process background approval job, and
closes the authorization window. Approval, rejection, expiration, and
connection failures are polled and displayed by the invite page. `postMessage`
remains only as a compatibility and fast-feedback channel.

The target service makes an outbound Socket.IO connection to the cloud
`/group-chat-agent-relay` namespace. A random pairing ticket is usable once and
for two minutes after owner approval; successful pairing replaces it with a
separate hashed reconnect credential. Request-status secrets are sent in a
header rather than a URL, and the public request endpoint also requires a
short-lived proof issued to the exact invite socket and persisted room member.
Room policy and per-member connection limits are rechecked transactionally
when the connector is created.

Remote Agents are registered as `executorType=remote`, are omitted from
profile-derived room authorization, are not cloned or restored as server-local
Agents, and can be revoked by either the room owner or the target service.
Target reconnect credentials stay in a mode-0600 file under
`HERMES_WEB_UI_HOME`; invite codes and Web UI login credentials are never used
as Agent relay credentials.

The cloud handoff is bound to the invite code, room member, target origin,
request secret, and exact Agent descriptor submitted by the authenticated
target service. Manual pairing remains available, but shows the decoded cloud
origin and Agent identity before the user connects.

An invite guest can click only a remote Agent that they own to reopen the
protected target configuration page. Saving uses the existing connector's
revocable Relay credential; the cloud derives the room and Agent identity from
that credential instead of accepting them from the browser. It revalidates
reserved and duplicate names, updates only that connector's Agent record, and
reconnects the target Relay so the next run uses the new profile, provider,
model, reasoning level, name, description, and avatar. Other guests never
receive the connector ID or target origin and continue to insert an `@Agent`
mention when they click the avatar. The protected target page has no Agent
removal action; removal remains a room-management operation in the group-chat
page.

Room managers may still remove any Agent from the room without opening its
configuration. A member may interrupt a currently running remote Agent only
when that Agent's persisted owner member ID matches the requesting socket;
the same owner may remove that remote Agent from its avatar popover even while
the Agent is offline. The room Socket revalidates joined human membership and
Agent ownership before revoking the connector and archiving the registration.
Room managers retain the existing interrupt and removal permissions.

Disconnected Agents remain visible in the room roster so their owner can
reconfigure, reconnect, or remove them, but they are excluded from mention
completion, avatar-click mentions, `@all` execution targets, and the live Agent
roster included in system prompts and Relay requests. Both server-local and
remote Agent availability are derived from the connected executor rather than
the persisted registration alone.

Removing an Agent archives its room registration instead of erasing the display
identity required by existing messages. Messages store only the archived Agent
record ID; one compact display snapshot per history page supplies the avatar
and configuration needed by the client cache. Connector credentials and remote
origins are cleared on removal, and clearing room context physically deletes
archived Agent registrations after their message references are gone. System
prompts label current participants explicitly as human members or AI Agents,
and removed Agent-member shadows do not reappear as humans.

Relay events are run-bound, ordered, size-limited, and mapped to fresh cloud
message and approval identifiers. Untrusted event metadata cannot override the
room, sender, message content, or message identifier. Current-message
attachments are served only through run-scoped chunk requests, validated
against the cloud room attachment directory, materialized beneath the target's
temporary group-relay attachment directory, and deleted after the run. The
cloud never fetches a user-supplied target URL and never receives access to the
target Agent's local workspace.

Group Chat runs now use the independent `group_chat` session source rather than
being recorded as workflow runs. Ordinary session history continues to hide
these ephemeral orchestration sessions, while explicit source filtering can
still retrieve them for diagnostics.
