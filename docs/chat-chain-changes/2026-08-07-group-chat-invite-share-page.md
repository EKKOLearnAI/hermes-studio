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

Invite guests can send messages to room Agents through explicit `@Agent` and
`@all` mentions. Clicking an Agent avatar inserts its mention for read-only
viewers, while management, workspace, interruption, and approval actions remain
restricted to room managers.

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

New room, clone, and rotation actions generate 16-character invite codes with
cryptographically secure random bytes and an alphabet that omits ambiguous
characters. Existing and manually entered shorter codes remain valid.
