# Session Attention States — Feature Design & Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task. Keep commits small and run the specified tests after each task.

## Goal

Replace the current session-list spinner-only behavior with a compact chat-like attention model that tells the user what requires attention in each session:

1. **Approval required** — the agent is blocked and waiting for the user.
2. **Agent working** — the agent is actively running.
3. **Unread agent result** — the agent produced output that the user has not seen.
4. **Read** — nothing currently needs attention.

This should make the session list feel more like a messenger/chat inbox while staying visually minimal.

---

## Final Product Design

### Attention states

```ts
export type SessionAttentionState =
  | 'approval'
  | 'working'
  | 'unread'
  | 'read'
```

Priority:

```text
approval > working > unread > read
```

Reasoning:

- `approval` is most important because the process is blocked until the user acts.
- `working` means the agent is still active.
- `unread` means the agent finished or produced something while the user was not looking.
- `read` is the neutral/default state.

### Visual language

| State | Product meaning | Session-list visual | Tooltip |
|---|---|---|---|
| `approval` | User action required | amber dot / small alert indicator; title slightly stronger | `Approval required` |
| `working` | Agent is running | pulsing accent dot/ring | `Agent is working…` |
| `unread` | New unseen agent output | solid accent dot; title slightly stronger | `New agent reply` |
| `read` | Nothing new | no indicator | none |

Suggested row examples:

```text
◆  Deploy production fix
   Approval required

◌  Investigate broken tests
   Agent is working…

●  Review PR comments
   New agent reply

   Old planning session
   gpt-4.1 · yesterday
```

### UX behavior

- Clicking an `approval` session opens the session; the existing approval bar/buttons are shown in the chat panel.
- Opening an `unread` session marks it read.
- Opening an `approval` session **must not hide the approval indicator**. It remains `approval` until resolved.
- If the active visible session receives agent output, it remains/read-becomes `read` because the user is already looking at it.
- If the active session receives agent output while the tab is hidden, it becomes `unread`.
- Approval state is not persisted in localStorage; it is live runtime state from socket events/resume.
- Read/unread state is persisted per profile in localStorage.

---

## Current Implementation Summary

Relevant files:

- `packages/client/src/stores/hermes/chat.ts`
- `packages/client/src/components/hermes/chat/ChatPanel.vue`
- `packages/client/src/components/hermes/chat/SessionListItem.vue`
- `packages/client/src/api/hermes/chat.ts`
- `packages/server/src/services/hermes/run-chat/index.ts`
- `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts`

### Current working/live state

In `chat.ts`:

```ts
const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
const serverWorking = ref<Set<string>>(new Set())

function isSessionLive(sessionId: string): boolean {
  return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
}
```

`ChatPanel.vue` currently passes this to `SessionListItem`:

```vue
:streaming="chatStore.isSessionLive(s.id)"
```

`SessionListItem.vue` renders a spinner SVG when `streaming` is true.

### Current approval state

In `chat.ts`:

```ts
export interface PendingApproval {
  sessionId: string
  approvalId: string
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allowPermanent: boolean
  requestedAt: number
}

const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())

const activePendingApproval = computed(() => {
  const sid = activeSessionId.value
  return sid ? pendingApprovals.value.get(sid) || null : null
})
```

Approval events are handled in multiple run/resume paths:

```ts
case 'approval.requested': {
  setPendingApproval(evt)
  break
}

case 'approval.resolved': {
  clearPendingApproval(evt)
  break
}
```

The active session’s approval is rendered in `ChatPanel.vue` as the existing `approval-bar` with allow/deny buttons.

Missing today:

- No session-list indication that a background session is waiting for approval.
- No `unread/read` tracking.
- No unified attention state.

---

## Non-goals

- No backend DB migration for read receipts in this iteration.
- No cross-device read-state sync.
- No unread count badge.
- No browser notifications.
- No sorting changes.
- No new approval workflow; reuse existing approval events and approval bar.
- Do not persist approval state in localStorage.
- Do not change route semantics or native-link behavior.

---

## Acceptance Criteria

1. `chatStore.sessionAttentionState(sessionId)` returns `approval` when `pendingApprovals` has that session.
2. `approval` wins over `working`, `unread`, and `read`.
3. `working` is returned when `isSessionLive(sessionId)` is true and there is no pending approval.
4. `unread` is returned when the session has unseen agent output and is not approval/working.
5. `read` is returned otherwise.
6. Opening/switching to a non-approval session marks it read.
7. Opening/switching to an approval session does not hide the approval state.
8. Background agent output marks that session unread.
9. Active visible session output does not become unread.
10. Active hidden-tab output becomes unread.
11. `approval.requested` sets session state to `approval` in the session list.
12. `approval.resolved` clears `approval`, after which the state falls back to `working`, `unread`, or `read`.
13. Read/unread state persists per profile via localStorage.
14. Approval state is not persisted to localStorage.
15. Session rows render a single attention indicator instead of the old spinner-only UI.
16. Batch-selection mode remains non-navigating and does not accidentally mark sessions read.
17. Native navigation/middle-click behavior remains intact.

---

## Storage Design

Read/unread is client-side and profile-scoped.

Storage key:

```ts
const SESSION_ATTENTION_STORAGE_PREFIX = 'hermes_session_attention_v1_'
```

Suggested persisted shape:

```ts
type SessionAttentionSnapshot = {
  unread: string[]
  seenAt: Record<string, number>
}
```

Notes:

- `unread` is the MVP source of truth.
- `seenAt` is useful for debugging and future migration to timestamp/message-count based receipts.
- Approval is intentionally excluded from this snapshot.

---

## Store API Design

In `packages/client/src/stores/hermes/chat.ts`, add/return:

```ts
export type SessionAttentionState = 'approval' | 'working' | 'unread' | 'read'

const unreadSessionIds = ref<Set<string>>(new Set())
const sessionSeenAt = ref<Record<string, number>>({})

function hasPendingApproval(sessionId: string): boolean
function sessionAttentionState(sessionId: string): SessionAttentionState
function markSessionUnread(sessionId: string): void
function markSessionRead(sessionId: string): void
function noteAgentActivity(sessionId: string): void
function loadSessionAttentionState(): void
function persistSessionAttentionState(): void
```

Core logic:

```ts
function sessionAttentionState(sessionId: string): SessionAttentionState {
  if (pendingApprovals.value.has(sessionId)) return 'approval'
  if (isSessionLive(sessionId)) return 'working'
  if (unreadSessionIds.value.has(sessionId)) return 'unread'
  return 'read'
}
```

Agent activity logic:

```ts
function isDocumentVisible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function shouldMarkSessionReadImmediately(sessionId: string) {
  return activeSessionId.value === sessionId && isDocumentVisible()
}

function noteAgentActivity(sessionId: string) {
  if (!sessionId) return
  if (shouldMarkSessionReadImmediately(sessionId)) markSessionRead(sessionId)
  else markSessionUnread(sessionId)
}
```

`markSessionUnread` should be a no-op if already unread to avoid localStorage spam during token deltas:

```ts
function markSessionUnread(sessionId: string) {
  if (!sessionId || unreadSessionIds.value.has(sessionId)) return
  unreadSessionIds.value.add(sessionId)
  persistSessionAttentionState()
}
```

---

## Event Policy

### Mark approval

On:

```ts
approval.requested
```

Do:

```ts
setPendingApproval(evt)
```

No need to call `markSessionUnread`; `approval` is stronger and live.

### Clear approval

On:

```ts
approval.resolved
```

Do:

```ts
clearPendingApproval(evt)
```

Then the session naturally falls back through:

```text
working -> unread -> read
```

### Mark unread/read on agent output

Call `noteAgentActivity(sessionId)` when visible agent/server output is produced, including:

- assistant/message deltas;
- reasoning/thinking deltas, if they create visible content;
- `run.completed` with final output or parsed content;
- `run.failed`;
- terminal/tool/subagent output if it is visible as transcript content.

Do not call for:

- user-submitted messages;
- queue length only;
- session list refresh only;
- local UI changes.

---

## Implementation Plan

### Task 1 — Add persisted read/unread primitives

**Objective:** Add localStorage-backed read/unread state and `SessionAttentionState` type, but do not wire socket events yet.

Files:

- `packages/client/src/stores/hermes/chat.ts`
- `tests/client/chat-session-attention.test.ts`

Steps:

1. Add tests for:
   - default state is `read`;
   - `markSessionUnread` -> `unread`;
   - `markSessionRead` -> `read`;
   - unread state persists per profile.
2. Implement:
   - `SessionAttentionState` type;
   - `unreadSessionIds`;
   - `sessionSeenAt`;
   - `loadSessionAttentionState`;
   - `persistSessionAttentionState`;
   - `markSessionUnread`;
   - `markSessionRead`.
3. Return these actions from the Pinia store.
4. Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Commit:

```bash
git commit -m "feat: add persisted session read state"
```

---

### Task 2 — Add approval-aware attention state

**Objective:** Combine existing approval state, existing live state, and new unread state into one priority-ordered session attention API.

Files:

- `packages/client/src/stores/hermes/chat.ts`
- `tests/client/chat-session-attention.test.ts`

Steps:

1. Add `hasPendingApproval(sessionId)`.
2. Add `sessionAttentionState(sessionId)` with priority:

```text
approval > working > unread > read
```

3. Add tests:
   - pending approval returns `approval`;
   - approval beats unread;
   - approval beats working;
   - after clear approval, state falls back to working/unread/read.
4. If direct `setPendingApproval` is not exported, either:
   - test via a small public helper if acceptable; or
   - expose a narrowly named test-friendly action only if the project already uses that pattern; or
   - test through existing event handler path if practical.

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Commit:

```bash
git commit -m "feat: derive approval-aware session attention state"
```

---

### Task 3 — Mark opened sessions read

**Objective:** Opening a session clears `unread`, but does not hide `approval`.

Files:

- `packages/client/src/stores/hermes/chat.ts`
- `tests/client/chat-session-attention.test.ts`

Steps:

1. In `switchSession(sessionId, ...)`, call:

```ts
markSessionRead(sessionId)
```

Recommended placement: after active session is selected, before/after resume is acceptable.

2. Ensure that even if `markSessionRead` is called, `sessionAttentionState` still returns `approval` while `pendingApprovals` contains the session.
3. Add tests:
   - opening unread session clears unread;
   - opening approval session still returns `approval`.

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Commit:

```bash
git commit -m "feat: mark viewed sessions as read"
```

---

### Task 4 — Mark background agent output unread

**Objective:** Agent output in a non-visible session becomes `unread`.

Files:

- `packages/client/src/stores/hermes/chat.ts`
- `tests/client/chat-session-attention.test.ts`

Steps:

1. Implement:

```ts
noteAgentActivity(sessionId)
```

2. Wire `noteAgentActivity` into run event handlers that add visible agent/system/tool output.
3. For high-frequency deltas, rely on `markSessionUnread` no-op guard.
4. Add tests:
   - non-active session activity -> unread;
   - active visible session activity -> read;
   - active hidden-tab session activity -> unread.

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
npm test -- tests/client/session-list-item.test.ts
```

Commit:

```bash
git commit -m "feat: mark unseen agent activity unread"
```

---

### Task 5 — Replace session row spinner with unified attention indicator

**Objective:** Replace `streaming` prop/UI with `attentionState`.

Files:

- `packages/client/src/components/hermes/chat/SessionListItem.vue`
- `packages/client/src/components/hermes/chat/ChatPanel.vue`
- `tests/client/session-list-item.test.ts`

Steps:

1. In `SessionListItem.vue`, replace:

```ts
streaming?: boolean
```

with:

```ts
attentionState?: 'approval' | 'working' | 'unread' | 'read'
```

Default: `read`.

2. Replace spinner SVG with:

```vue
<span
  v-if="attentionState !== 'read'"
  class="session-attention-indicator"
  :class="`session-attention-indicator--${attentionState}`"
  :title="attentionTooltip"
  aria-hidden="true"
/>
```

3. Add classes on row:

```vue
:class="{
  active,
  'batch-mode': selectable,
  'missing-models': profileModelsMissing,
  unread: attentionState === 'unread',
  approval: attentionState === 'approval',
}"
```

4. CSS:

```scss
.session-attention-indicator {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 999px;
  margin-top: 0.35rem;
}

.session-attention-indicator--approval {
  background: #f59e0b;
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.25);
}

.session-attention-indicator--working {
  background: $accent-primary;
  box-shadow: 0 0 0 0 rgba($accent-primary, 0.45);
  animation: session-attention-pulse 1.4s ease-out infinite;
}

.session-attention-indicator--unread {
  background: $accent-primary;
}

.session-item.unread .session-item-title,
.session-item.approval .session-item-title {
  color: $text-primary;
  font-weight: 650;
}

@keyframes session-attention-pulse {
  0% { box-shadow: 0 0 0 0 rgba($accent-primary, 0.45); opacity: 1; }
  70% { box-shadow: 0 0 0 6px rgba($accent-primary, 0); opacity: 0.85; }
  100% { box-shadow: 0 0 0 0 rgba($accent-primary, 0); opacity: 1; }
}
```

Adapt variables to the file’s existing SCSS variables.

5. In `ChatPanel.vue`, replace:

```vue
:streaming="chatStore.isSessionLive(s.id)"
```

with:

```vue
:attention-state="chatStore.sessionAttentionState(s.id)"
```

Do this for pinned and unpinned rows.

6. Add `SessionListItem` tests for:
   - `approval` indicator;
   - `working` indicator;
   - `unread` indicator;
   - no indicator for `read`;
   - nested delete/warning action buttons still do not navigate/select unexpectedly.

Run:

```bash
npm test -- tests/client/session-list-item.test.ts
npm run build
```

Commit:

```bash
git commit -m "feat: show session attention indicators"
```

---

### Task 6 — Add i18n labels

**Objective:** Add tooltip labels.

Files:

- `packages/client/src/i18n/locales/*.ts`

Keys under `chat`:

```ts
approvalRequired: 'Approval required',
agentWorking: 'Agent is working…',
newAgentReply: 'New agent reply',
```

For non-English locales, English fallback is acceptable for MVP unless translations are already maintained in the same change.

Run:

```bash
npm run build
```

Commit:

```bash
git commit -m "feat: add session attention labels"
```

---

### Task 7 — Add E2E coverage

**Objective:** Prevent regressions in visible list behavior.

Files:

- `tests/e2e/session-attention-states.spec.ts`
- optionally `tests/e2e/fixtures.ts`

Tests:

1. Read baseline:
   - load session list;
   - assert no `.session-attention-indicator` for normal read row.

2. Persisted unread:
   - seed localStorage:

```ts
localStorage.setItem('hermes_session_attention_v1_research', JSON.stringify({
  unread: ['session-unread-1'],
  seenAt: {},
}))
```

   - assert `.session-attention-indicator--unread` appears.

3. Opening unread clears indicator:
   - click row;
   - assert indicator disappears.

4. Approval state if practical:
   - either mock socket `approval.requested`, or unit-test this only if E2E socket simulation is too heavy.

Route note:

- On fork clean-router main use `/chat`.
- On upstream hash-router branch use `/#/hermes/chat`.

Run:

```bash
npm run test:e2e -- tests/e2e/session-attention-states.spec.ts
```

Commit:

```bash
git commit -m "test: cover session attention states"
```

---

### Task 8 — Final verification and review

Run targeted tests:

```bash
npm test -- \
  tests/client/chat-session-attention.test.ts \
  tests/client/session-list-item.test.ts \
  tests/client/sidebar-search.test.ts
```

Run targeted E2E:

```bash
npm run test:e2e -- \
  tests/e2e/session-attention-states.spec.ts \
  tests/e2e/native-navigation.spec.ts \
  tests/e2e/authenticated-shell.spec.ts
```

Build:

```bash
npm run build
```

Manual QA:

1. Open `/chat`.
2. Start an agent run in session A.
3. Confirm A shows `working` pulsing indicator.
4. Switch to session B while A is running.
5. Let A produce output/finish.
6. Confirm A becomes `unread` if no approval is pending.
7. Open A.
8. Confirm unread indicator disappears.
9. Trigger a command requiring approval.
10. Confirm session row shows amber `approval` indicator.
11. Open approval session.
12. Confirm approval bar is visible and indicator remains `approval` until choice is submitted/resolved.
13. Approve/deny.
14. Confirm indicator falls back to `working` or later `unread/read`.
15. Reload page.
16. Confirm unread persists; stale approval does not persist falsely.
17. Confirm middle-click on session rows still works.
18. Confirm batch-select mode still selects sessions and does not navigate.

Security/static scan:

```bash
git diff --cached | grep '^+' | grep -iE "(api_key|secret|password|token|passwd)\s*=\s*['\"][^'\"]{6,}['\"]" || true
git diff --cached | grep '^+' | grep -E "os\.system\(|subprocess.*shell=True|\beval\(|\bexec\(|pickle\.loads?\(|execute\(f\"|\.format\(.*SELECT|\.format\(.*INSERT" || true
```

Request code review with focus on:

- `approval` priority over `working` and `unread`;
- approval not persisted to localStorage;
- no localStorage spam during streaming deltas;
- active visible sessions not becoming unread;
- hidden active tab becoming unread;
- no regression to native session links / nested action buttons.

---

## Risk Notes

### Risk: localStorage writes on every token

Mitigation:

- `markSessionUnread` no-ops if already unread.
- Prefer calling `noteAgentActivity` on assistant message creation/completion when easy.

### Risk: approval hidden by read marker

Mitigation:

- `sessionAttentionState` must check `pendingApprovals` first.
- Opening a session can call `markSessionRead`, but `approval` still wins.

### Risk: stale approval if persisted

Mitigation:

- Do not persist approval.
- Rely on socket events/resume while run is working.

### Risk: background approval not visible

Mitigation:

- Existing `pendingApprovals` already stores by sessionId; session list should query `sessionAttentionState(s.id)` for every row.

### Risk: batch mode side effects

Mitigation:

- Selection mode should not call `switchSession`, so it should not mark sessions read.
- Keep tests for selectable rows.

---

## Future Enhancements

Not part of this MVP:

1. Server-side read receipts per user/profile/session.
2. Cross-device unread sync.
3. Unread counts.
4. Browser notifications for background completion/approval.
5. Separate `failed` attention state.
6. “Mark all as read”.
7. Sort approval/unread sessions above read sessions.

Possible future type:

```ts
type SessionAttentionState =
  | 'approval'
  | 'failed'
  | 'working'
  | 'unread'
  | 'read'
```

For now, keep the first shipped version compact:

```text
approval > working > unread > read
```
