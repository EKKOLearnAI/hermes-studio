# Session List and Multi-Profile Status Sync Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Complete the Web UI state sync foundation by refreshing session lists across tabs/windows and storing/subscribing to runtime session statuses by profile instead of active profile only.

**Architecture:** Reuse the existing profile-level `/chat-run` status room introduced in PR #986. Add a lightweight `session.list.changed` invalidation event that triggers debounced client refreshes without changing tab-local route state. Refactor runtime status storage from `Map<sessionId, status>` to `Map<profile, Map<sessionId, status>>` and subscribe to every profile represented in the currently visible session list plus the active profile.

**Tech Stack:** Vue 3, Pinia, TypeScript, Socket.IO, Vitest, Playwright.

---

## Current Problems

1. A session created in one tab/window does not appear in another until reload because there is no session-list invalidation event.
2. Runtime statuses are stored and filtered by active profile only, so sessions from other visible profiles lose `working`/`approval` indicators.

## Non-Goals

- Do not sync active route/session across tabs.
- Do not send message content, queued input, approval command, or approval description over the profile status feed.
- Do not rewrite the whole session list data model.
- Do not make status subscriptions global for every known profile unless those profiles are represented in the current session list or active profile.

## Acceptance Criteria

1. Creating a session in one tab emits a profile-scoped invalidation event.
2. Other tabs subscribed to that profile refresh session list without reload.
3. Background list refresh does not change active route/session.
4. Runtime statuses are stored by profile.
5. A session row from a non-active profile can show `working`/`approval` if its profile status feed reports it.
6. Active profile switch starts status sync for the new profile and does not wipe unrelated profile status maps unnecessarily.
7. Existing PR #986 checks remain green.
8. Existing chat streaming queued-run e2e remains green with separate run/status sockets.

---

## Task 1: Add server-side session list invalidation event

**Objective:** Emit lightweight profile-scoped `session.list.changed` events when server-side session list membership/metadata changes.

**Files:**
- Modify: `packages/server/src/services/hermes/run-chat/status-feed.ts`
- Modify: `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts`
- Modify as applicable: `packages/server/src/services/hermes/run-chat/session-command.ts`
- Test: `tests/server/chat-run-status-feed.test.ts`

**Step 1: Write failing server test**

In `tests/server/chat-run-status-feed.test.ts`, add a test for `emitSessionListChanged()`:

```ts
it('emits session list changed to the profile status room', () => {
  const emit = vi.fn()
  const to = vi.fn(() => ({ emit }))
  const nsp = { to } as any

  emitSessionListChanged(nsp, 'research', 'created', 'session-1')

  expect(to).toHaveBeenCalledWith('profile:research:session-status')
  expect(emit).toHaveBeenCalledWith('session.list.changed', {
    profile: 'research',
    reason: 'created',
    session_id: 'session-1',
    updatedAt: expect.any(Number),
  })
})
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/server/chat-run-status-feed.test.ts
```

Expected: FAIL because `emitSessionListChanged` is not exported.

**Step 3: Implement helper**

In `status-feed.ts`, add:

```ts
export type SessionListChangedReason = 'created' | 'renamed' | 'deleted' | 'updated' | 'cleared'

export interface SessionListChangedPayload {
  profile: string
  reason: SessionListChangedReason
  session_id?: string
  updatedAt: number
}

export function emitSessionListChanged(
  nsp: Server['sockets'] | ReturnType<Server['of']>,
  profile: string,
  reason: SessionListChangedReason,
  sessionId?: string,
): void {
  nsp.to(sessionStatusRoom(profile)).emit('session.list.changed', {
    profile,
    reason,
    session_id: sessionId,
    updatedAt: Date.now(),
  } satisfies SessionListChangedPayload)
}
```

Adjust type to match existing `emitSessionStatus()` style if needed.

**Step 4: Emit after session creation**

In `handle-bridge-run.ts`, after `createSession(...)` for a previously missing session, call:

```ts
emitSessionListChanged(nsp, profile, 'created', session_id)
```

Important: emit after `createSession` so clients can immediately fetch the new session.

**Step 5: Emit for session commands where obvious**

In `session-command.ts`, inspect existing rename/delete/clear/update session paths. Add:

```ts
emitSessionListChanged(ctx.nsp, ctx.profile, 'renamed', sessionId)
emitSessionListChanged(ctx.nsp, ctx.profile, 'deleted', sessionId)
emitSessionListChanged(ctx.nsp, ctx.profile, 'cleared', sessionId)
emitSessionListChanged(ctx.nsp, ctx.profile, 'updated', sessionId)
```

Only add where the file already has direct access to `ctx.nsp`, `ctx.profile`, and a successful mutation. Do not overbuild if no such command path exists.

**Step 6: Verify**

Run:

```bash
npm test -- tests/server/chat-run-status-feed.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/server/src/services/hermes/run-chat/status-feed.ts \
  packages/server/src/services/hermes/run-chat/handle-bridge-run.ts \
  packages/server/src/services/hermes/run-chat/session-command.ts \
  tests/server/chat-run-status-feed.test.ts
git commit -m "feat: emit session list invalidation events"
```

---

## Task 2: Add client API support for session list invalidation

**Objective:** Let chat store receive `session.list.changed` events through `subscribeSessionStatus()`.

**Files:**
- Modify: `packages/client/src/api/hermes/chat.ts`
- Test: `tests/client/chat-status-sync.test.ts` if present, otherwise extend `tests/client/chat-session-attention.test.ts`

**Step 1: Add types**

In `chat.ts` API module, add:

```ts
export type SessionListChangedReason = 'created' | 'renamed' | 'deleted' | 'updated' | 'cleared'

export interface SessionListChangedPayload {
  profile: string
  reason: SessionListChangedReason
  session_id?: string
  updatedAt: number
}
```

**Step 2: Extend handler signature**

Change `subscribeSessionStatus()` handlers to include:

```ts
onSessionListChanged?: (payload: SessionListChangedPayload) => void
```

**Step 3: Add listener and cleanup**

Inside `subscribeSessionStatus()`:

```ts
const onSessionListChanged = (payload: SessionListChangedPayload) => handlers.onSessionListChanged?.(payload)
socket.on('session.list.changed', onSessionListChanged)
```

Cleanup:

```ts
removeSocketListener(socket, 'session.list.changed', onSessionListChanged)
```

**Step 4: Verify**

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/client/src/api/hermes/chat.ts tests/client/chat-session-attention.test.ts
git commit -m "feat: handle session list invalidation events"
```

---

## Task 3: Refresh session list from invalidation without changing active route

**Objective:** Debounced `session.list.changed` refreshes `sessions.value` in other tabs without switching active session.

**Files:**
- Modify: `packages/client/src/stores/hermes/chat.ts`
- Test: `tests/client/chat-session-attention.test.ts`

**Step 1: Add loadSessions option**

Current store has `loadSessions(profile?, preferredSessionId?)`. Add optional third arg:

```ts
interface LoadSessionsOptions {
  preserveActive?: boolean
  switchIfMissing?: boolean
}
```

Default must preserve current behavior:

```ts
async function loadSessions(profile?: string | null, preferredSessionId?: string | null, options: LoadSessionsOptions = {})
```

For normal load, behavior remains unchanged. For invalidation refresh:

```ts
await loadSessions(profile, null, { preserveActive: true, switchIfMissing: false })
```

**Step 2: Preserve active route/session**

In the `loadSessions` section that auto-selects/switches sessions, guard with:

```ts
if (!options.preserveActive) {
  // existing auto-switch behavior
}
```

If current active session was deleted and `switchIfMissing !== false`, existing fallback behavior may run. If `switchIfMissing === false`, do not route-switch.

**Step 3: Add debounced refresh helper**

Add store-scoped timers:

```ts
const sessionListRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

Add:

```ts
function scheduleSessionListRefresh(profile: string): void {
  const normalizedProfile = profile?.trim() || getProfileName()
  const existing = sessionListRefreshTimers.get(normalizedProfile)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    sessionListRefreshTimers.delete(normalizedProfile)
    void loadSessions(normalizedProfile, null, { preserveActive: true, switchIfMissing: false })
  }, 150)
  sessionListRefreshTimers.set(normalizedProfile, timer)
}
```

**Step 4: Wire to status subscription**

When calling `subscribeSessionStatus(profile, handlers)`, pass:

```ts
onSessionListChanged: payload => {
  if (payload.profile) scheduleSessionListRefresh(payload.profile)
}
```

**Step 5: Unit test**

In `chat-session-attention.test.ts`, mock `subscribeSessionStatus` handlers already exist. Add:

```ts
it('refreshes sessions without changing active session on list invalidation', async () => {
  vi.useFakeTimers()
  const store = useChatStore()
  store.startSessionStatusSync('research')
  store.activeSessionId = 'session-read-1'

  // mock fetchSessions to return existing + new session if test infra allows
  statusMock.handlers?.onSessionListChanged?.({ profile: 'research', reason: 'created', session_id: 'new-session', updatedAt: Date.now() })
  await vi.advanceTimersByTimeAsync(151)

  expect(store.activeSessionId).toBe('session-read-1')
  vi.useRealTimers()
})
```

Adapt to existing test mocks.

**Step 6: Verify**

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/client/src/stores/hermes/chat.ts tests/client/chat-session-attention.test.ts
git commit -m "feat: refresh sessions from sync invalidations"
```

---

## Task 4: Store runtime statuses by profile

**Objective:** A row's runtime indicator should use `session.profile`, not only the active profile.

**Files:**
- Modify: `packages/client/src/stores/hermes/chat.ts`
- Test: `tests/client/chat-session-attention.test.ts`

**Step 1: Replace runtime state shape**

Replace:

```ts
const runtimeStatuses = ref<Map<string, SessionRuntimeStatus>>(new Map())
```

with:

```ts
const runtimeStatusesByProfile = ref<Map<string, Map<string, SessionRuntimeStatus>>>(new Map())
```

**Step 2: Add helpers**

```ts
function isActiveRuntimeStatus(status: SessionRuntimeStatus): boolean {
  return Boolean(status.isWorking || status.isAborting || (status.queueLength ?? 0) > 0 || status.pendingApproval)
}

function profileForSession(sessionId: string): string {
  return sessions.value.find(session => session.id === sessionId)?.profile || getProfileName()
}

function runtimeStatusForSession(sessionId: string): SessionRuntimeStatus | null {
  const profile = profileForSession(sessionId)
  return runtimeStatusesByProfile.value.get(profile)?.get(sessionId) || null
}
```

**Step 3: Refactor snapshot/update application**

`applyRuntimeSnapshot(payload)` should replace only `payload.profile`:

```ts
const next = new Map(runtimeStatusesByProfile.value)
const profileMap = new Map<string, SessionRuntimeStatus>()
for (const status of payload.sessions) {
  if (isActiveRuntimeStatus(status)) profileMap.set(status.session_id, status)
}
if (profileMap.size) next.set(payload.profile, profileMap)
else next.delete(payload.profile)
runtimeStatusesByProfile.value = next
```

`applyRuntimeStatus(status)` should update only `status.profile` and should not filter by active profile.

**Step 4: Refactor consumers**

Update:

- `isSessionLive(sessionId)`
- `hasPendingApproval(sessionId)`
- `runtimePendingApproval(sessionId)`
- `respondApproval(...)` runtime clearing path
- any other `runtimeStatuses.value.get(...)`

Use `runtimeStatusForSession(sessionId)`.

**Step 5: Unit tests**

Add tests:

```ts
it('shows runtime status for a non-active profile session', () => {
  const store = useChatStore()
  store.sessions = [{ id: 'other-session', profile: 'personal', ...sessionFixture }]
  store.startSessionStatusSync('personal')
  statusMock.handlersByProfile.personal.onUpdate({ profile: 'personal', session_id: 'other-session', isWorking: true, updatedAt: Date.now() })
  expect(store.sessionAttentionState('other-session')).toBe('working')
})
```

Adapt to existing mocks; a simple single-handler test is acceptable if multi-profile mocks are added in Task 5.

**Step 6: Verify**

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/client/src/stores/hermes/chat.ts tests/client/chat-session-attention.test.ts
git commit -m "feat: store runtime session statuses by profile"
```

---

## Task 5: Subscribe to active and visible session profiles

**Objective:** Keep status subscriptions alive for active profile plus profiles represented in the loaded session list.

**Files:**
- Modify: `packages/client/src/stores/hermes/chat.ts`
- Modify if needed: `tests/client/chat-session-attention.test.ts`

**Step 1: Replace single subscription with map**

Replace:

```ts
let stopStatusSync: (() => void) | null = null
```

with:

```ts
const statusSubscriptions = new Map<string, () => void>()
```

**Step 2: Add profile set helper**

```ts
function profilesNeedingStatusSync(): string[] {
  const profiles = new Set<string>()
  profiles.add(getProfileName())
  for (const session of sessions.value) {
    profiles.add(session.profile || getProfileName())
  }
  return [...profiles]
}
```

**Step 3: Add sync function**

```ts
function syncSessionStatusSubscriptions(profiles = profilesNeedingStatusSync()): void {
  const desired = new Set(profiles.map(profile => profile?.trim() || 'default'))
  for (const profile of desired) {
    if (statusSubscriptions.has(profile)) continue
    const stop = subscribeSessionStatus(profile, {
      onSnapshot: applyRuntimeSnapshot,
      onUpdate: applyRuntimeStatus,
      onSessionListChanged: payload => scheduleSessionListRefresh(payload.profile),
    })
    statusSubscriptions.set(profile, stop)
  }
  for (const [profile, stop] of [...statusSubscriptions]) {
    if (!desired.has(profile)) {
      stop()
      statusSubscriptions.delete(profile)
      removeRuntimeStatusesForProfile(profile)
    }
  }
}
```

**Step 4: Keep public API backward compatible**

Keep `startSessionStatusSync(profile?: string): () => void` exported from the store, but implement it by seeding active profile and then calling `syncSessionStatusSubscriptions()`.

```ts
function startSessionStatusSync(profile = getProfileName()): () => void {
  syncSessionStatusSubscriptions([profile, ...profilesNeedingStatusSync()])
  return stopAllSessionStatusSync
}
```

**Step 5: Call after session loads and profile changes**

After `sessions.value = ...` in `loadSessions()`, call:

```ts
syncSessionStatusSubscriptions()
```

In profile watcher, do not clear all runtime statuses. Instead:

```ts
loadSessionAttentionState()
syncSessionStatusSubscriptions()
```

**Step 6: Cleanup timers/subscriptions**

Ensure store has `stopAllSessionStatusSync()`:

```ts
function stopAllSessionStatusSync(): void {
  for (const stop of statusSubscriptions.values()) stop()
  statusSubscriptions.clear()
  for (const timer of sessionListRefreshTimers.values()) clearTimeout(timer)
  sessionListRefreshTimers.clear()
}
```

Return/export it if existing code expects cleanup.

**Step 7: Unit tests**

Extend mock `subscribeSessionStatus` to store handlers by profile:

```ts
handlersByProfile[profile] = handlers
```

Test:

- subscriptions are created for active profile plus session profiles after `loadSessions()`;
- profile B status updates profile B session indicator while active profile is A.

**Step 8: Verify**

Run:

```bash
npm test -- tests/client/chat-session-attention.test.ts
```

Expected: PASS.

**Step 9: Commit**

```bash
git add packages/client/src/stores/hermes/chat.ts tests/client/chat-session-attention.test.ts
git commit -m "feat: sync session statuses for visible profiles"
```

---

## Task 6: Add E2E coverage for invalidation and run final checks

**Objective:** Prove the user-visible sync gaps stay fixed.

**Files:**
- Modify: `tests/e2e/session-attention-states.spec.ts`
- Modify if needed: `tests/e2e/fixtures.ts`

**Step 1: Add cross-tab list invalidation E2E**

Use existing socket mock if practical. Scenario:

1. Open two pages with the same profile.
2. Mock initial session list on both pages with one session.
3. Update second page route mock to return an added session after invalidation.
4. Emit or simulate `session.list.changed` through mocked chat socket/status handlers.
5. Assert second page shows the new session without reload.

If existing mock socket infra makes this too brittle, add a unit test instead and document the limitation in commit message.

**Step 2: Run targeted E2E**

```bash
npm run test:e2e -- tests/e2e/chat-streaming.spec.ts tests/e2e/session-attention-states.spec.ts
```

Expected: PASS.

**Step 3: Run unit/server tests**

```bash
npm test -- tests/client/browser-sync.test.ts tests/client/chat-session-attention.test.ts tests/server/chat-run-status-feed.test.ts tests/client/session-list-item.test.ts
```

Expected: PASS.

**Step 4: Build**

```bash
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/e2e/session-attention-states.spec.ts tests/e2e/fixtures.ts
git commit -m "test: cover session list sync invalidation"
```

---

## Final Integration Steps

After implementation is complete on `upstream-pr/web-ui-state-sync-foundation`:

1. Push the PR branch:

```bash
git push origin upstream-pr/web-ui-state-sync-foundation
```

2. Update the draft PR body if needed with a short note:

```text
Update: also syncs session-list invalidations and multi-profile runtime statuses.
```

3. Merge the updated PR branch into local fork `main` for live usage. Because local `main` may contain older/rebased copies of the same feature, prefer an integration strategy that avoids duplicate commits. If direct merge is unsafe, create/reset a local integration main from the current deployed main and cherry-pick only new fix commits.

4. Build and restart local service:

```bash
npm run build
systemctl --user restart hermes-web-ui.service
systemctl --user is-active hermes-web-ui.service
curl -fsS http://127.0.0.1:8648/health
```

5. Verify `/health` reports the deployed local `main` SHA.
