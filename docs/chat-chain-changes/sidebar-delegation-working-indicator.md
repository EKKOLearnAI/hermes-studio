# Sidebar working indicator during background delegation

## Scope

The session-list working glow reflects foreground execution **or** a positive,
server-reported background delegation count. Foreground completion must not stop
that glow while delegated work is pending. The existing `isSessionLive`,
`isStreaming`, and `isRunActive` contracts remain foreground-only: queue insertion,
voice interruption, and composer controls must not change just for a sidebar cue.

The chat store retains `background_pending` from live events and replaces it from
`backgroundPending` in session-switch, reconnect, and visibility-resume snapshots.
Historical subagent/tool traces are not evidence of current work. The aggregate
count includes result delivery; a single child completion does not imply every
delegation is terminal. Zero counts and terminal run events clear activity; runtime
switches clear counts and invalidate earlier runtime callbacks. Session IDs follow
the existing store/socket session ownership, including profile-scoped transport.

Each known positive-background session temporarily owns a profile/transport-scoped
status socket, independent of the execution socket. It resumes its session room
on reconnect, so completion is still observed after switching execution profiles.
The observer closes at terminal activity, deletion/archive, store/runtime disposal,
or actual credential/backend invalidation. Credential clearing and replacement
invalidate old callbacks and asynchronous send preparation without aborting server
work; fresh login establishes new authenticated listeners. This costs one additional
socket per known background-active session, not a polling loop or a task database.

Session lists use the new display-only `isSessionWorking` predicate. There are no
new labels or badges, server changes, persisted state, or modifications to Hermes
runtime delegation. Reload restores activity for sessions resumed by the existing
architecture; this does not add a global background-task discovery endpoint for
unopened sessions.

## Related work

Refs #2625 and open PR #2629. This is an alternative, narrower fix: it retains the
existing glow and separates visual activity from execution/queue semantics rather
than broadening `isSessionLive` or adding active-chat text and count badges.

## Regression coverage

- `tests/client/chat-store-working-state.test.ts`: foreground/background overlap,
  multiple delegations and terminal outcomes, session/profile separation,
  authoritative resume/reconnect versus stale history, runtime reset and late
  callbacks, visibility wake/passive listener attachment.
- `tests/client/chat-store-working-transport.test.ts`: real API/store auth invalidation,
  socket-room loss/reconnect, profile replacement, cancellation payloads, resource
  disposal, delayed old-auth callbacks/uploads/model readiness, and fresh login.
- `tests/e2e/chat-streaming.spec.ts`: foreground → background-only → terminal glow,
  with the real center transcript and right-hand subagent panel rendered together.
- `tests/e2e/sidebar-working.spec.ts`: navigation, reload, enabled composer, partial
  completion, aggregate zero, and terminal reload despite historical task events.
- Browser screenshots use explicitly mocked API/socket fixtures, not live tasks.

## Validation

```sh
PATH=/opt/homebrew/bin:$PATH NODE_ENV=test npm run test -- tests/client
PATH=/opt/homebrew/bin:$PATH NODE_ENV=development PLAYWRIGHT_PORT=14387 PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- tests/e2e/chat-streaming.spec.ts tests/e2e/sidebar-working.spec.ts --workers=2
PATH=/opt/homebrew/bin:$PATH NODE_ENV=production npm run build
PATH=/opt/homebrew/bin:$PATH npm run harness:check
```

The absolute Node path and Chrome channel are local environment choices; CI can use
its supported Node and managed Playwright browser. Bound browser workers on a busy
developer machine to avoid unrelated five-second initial-render timeouts.
