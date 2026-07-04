# Personal Autopilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a first-pass Personal OS autopilot that reads existing Personal State and Health State data, diagnoses the current state, and shows one next best action instead of making the user inspect Smart Planning all day.

**Architecture:** Add a lightweight rule-based autopilot service on top of existing `personal-state` and `health-state` services. Expose it through a small Koa API and client wrapper. Update `PersonalOSView` into a command center while keeping `SmartPlanningView` as the detailed planning route.

**Tech Stack:** TypeScript, Koa, Vue 3 Composition API, Naive UI, Vitest, existing Hermes Studio API helpers.

---

### Task 1: Autopilot Service

**Files:**
- Create: `packages/server/src/services/hermes/personal-autopilot.ts`
- Test: `tests/server/personal-autopilot-service.test.ts`

**Step 1: Write the failing tests**

Create tests for a pure decision builder so the service can be verified without HTTP:

```ts
import { describe, expect, it } from 'vitest'
import { buildPersonalAutopilotSnapshot } from '../../packages/server/src/services/hermes/personal-autopilot'

describe('personal autopilot service', () => {
  it('selects the next scheduled task as the next best action', () => {
    const snapshot = buildPersonalAutopilotSnapshot({
      now: new Date('2026-07-04T09:00:00+08:00'),
      personal: {
        planningContext: {
          todayTasks: [
            {
              id: 'task-breakfast',
              title: '吃高蛋白早餐',
              notes: '鸡蛋和酸奶',
              status: 'open',
              priority: 'high',
              dueAt: null,
              scheduledStart: '2026-07-04T09:15:00+08:00',
              scheduledEnd: null,
              projectId: null,
              tags: ['diet'],
            },
          ],
          activeProjects: [],
          upcomingEvents: [],
          inboxItems: [],
          plans: [],
          pendingProposals: [],
          overdueTasks: [],
        },
      },
      health: {
        digitalTwinSummary: {
          currentWeightKg: 80,
          targetWeightKg: 75,
          externalConcernCount: 1,
          internalMarkerCount: 0,
          micronutrientGapCount: 0,
        },
        nutritionSummary: { consumed: {}, targets: {}, remaining: {} },
        recentWorkouts: [],
        foodLogs: [],
        internalMarkers: [],
      },
    } as any)

    expect(snapshot.mode).toBe('nudge')
    expect(snapshot.nextAction).toMatchObject({
      domain: 'diet',
      sourceId: 'task-breakfast',
      title: '吃高蛋白早餐',
    })
  })

  it('switches to takeover mode when execution is collapsing', () => {
    const snapshot = buildPersonalAutopilotSnapshot({
      now: new Date('2026-07-04T22:30:00+08:00'),
      personal: {
        planningContext: {
          todayTasks: [
            { id: 'task-workout', title: '训练', notes: '', status: 'open', priority: 'high', scheduledStart: '2026-07-04T18:00:00+08:00', scheduledEnd: null, dueAt: null, projectId: null, tags: ['workout'] },
            { id: 'task-skincare', title: '护肤', notes: '', status: 'open', priority: 'medium', scheduledStart: '2026-07-04T22:00:00+08:00', scheduledEnd: null, dueAt: null, projectId: null, tags: ['skin'] },
          ],
          activeProjects: [],
          upcomingEvents: [],
          inboxItems: [],
          plans: [],
          pendingProposals: [],
          overdueTasks: [],
        },
      },
      health: {
        digitalTwinSummary: { currentWeightKg: 80, targetWeightKg: 75, externalConcernCount: 0, internalMarkerCount: 0, micronutrientGapCount: 0 },
        nutritionSummary: { consumed: {}, targets: {}, remaining: {} },
        recentWorkouts: [],
        foodLogs: [],
        internalMarkers: [],
      },
    } as any)

    expect(snapshot.mode).toBe('takeover')
    expect(snapshot.nextAction.fallbackTitle).toContain('5')
  })
})
```

**Step 2: Run the tests to verify failure**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-service.test.ts --reporter=dot
```

Expected: FAIL because `personal-autopilot.ts` does not exist.

**Step 3: Implement the minimal service**

Create:

```ts
export type AutopilotMode = 'silent' | 'nudge' | 'correct' | 'takeover' | 'upgrade'

export interface PersonalAutopilotSnapshot {
  generatedAt: string
  mode: AutopilotMode
  state: {
    body: string
    diet: string
    skin: string
    recovery: string
    order: string
  }
  nextAction: {
    id: string
    domain: 'body' | 'diet' | 'skin' | 'recovery' | 'order' | 'planning'
    title: string
    reason: string
    sourceId: string | null
    fallbackTitle: string
  }
  signals: Array<{ key: string; label: string; status: string; value: string }>
}
```

Implement:

- `buildPersonalAutopilotSnapshot(input)` as a pure function.
- `getPersonalAutopilotOverview({ profile })` that calls `getPersonalStateOverview({ profile })` and `getHealthOverview({ profile })`.
- Domain detection from task tags and title keywords:
  - diet: `diet`, `meal`, `food`, `早餐`, `午餐`, `晚餐`, `饮食`
  - body: `workout`, `training`, `运动`, `训练`, `体重`, `身材`
  - skin: `skin`, `skincare`, `护肤`, `皮肤`
  - recovery: `sleep`, `睡眠`, `休息`, `恢复`
  - order: `整理`, `收纳`, `家务`, `秩序`
- Mode rules:
  - `takeover` when there are 2 or more overdue/open scheduled actions and local time is after 21:00.
  - `correct` when there are overdue actions earlier in the day.
  - `nudge` when the next scheduled action is within 90 minutes.
  - `silent` when there is no useful action.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-service.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/personal-autopilot.ts tests/server/personal-autopilot-service.test.ts
git commit -m "feat: add personal autopilot service"
```

### Task 2: Autopilot API

**Files:**
- Create: `packages/server/src/controllers/hermes/personal-autopilot.ts`
- Create: `packages/server/src/routes/hermes/personal-autopilot.ts`
- Modify: `packages/server/src/routes/index.ts`
- Test: `tests/server/personal-autopilot-controller.test.ts`
- Test: `tests/server/personal-autopilot-routes.test.ts`

**Step 1: Write failing route and controller tests**

Route test should expect:

```ts
expect(paths).toContain('/api/hermes/personal-autopilot/overview')
```

Controller test should mock `getPersonalAutopilotOverview` and assert:

```ts
expect(ctx.body).toEqual({ overview: mockedOverview })
```

Also copy the profile access behavior from `health-state` and `personal-state` controller tests: non-super-admin users can only request assigned profiles.

**Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-controller.test.ts tests/server/personal-autopilot-routes.test.ts --reporter=dot
```

Expected: FAIL because controller and route do not exist.

**Step 3: Implement controller and route**

Controller:

```ts
export async function overview(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { overview: getPersonalAutopilotOverview({ profile }) }
}
```

Route:

```ts
export const personalAutopilotRoutes = new Router()
personalAutopilotRoutes.get('/api/hermes/personal-autopilot/overview', ctrl.overview)
```

Register the route in `packages/server/src/routes/index.ts` near other local Hermes routes, before proxy catch-all routes.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-controller.test.ts tests/server/personal-autopilot-routes.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/controllers/hermes/personal-autopilot.ts packages/server/src/routes/hermes/personal-autopilot.ts packages/server/src/routes/index.ts tests/server/personal-autopilot-controller.test.ts tests/server/personal-autopilot-routes.test.ts
git commit -m "feat: expose personal autopilot api"
```

### Task 3: Client API

**Files:**
- Create: `packages/client/src/api/hermes/personal-autopilot.ts`
- Test: `tests/client/personal-autopilot-api.test.ts`

**Step 1: Write the failing API test**

Test:

```ts
import { describe, expect, it, vi } from 'vitest'
import { request } from '../../packages/client/src/api/client'
import { fetchPersonalAutopilotOverview } from '../../packages/client/src/api/hermes/personal-autopilot'

vi.mock('../../packages/client/src/api/client', () => ({ request: vi.fn() }))

it('fetches autopilot overview with optional profile', async () => {
  vi.mocked(request).mockResolvedValueOnce({ overview: { mode: 'nudge' } })
  await fetchPersonalAutopilotOverview({ profile: 'default' })
  expect(request).toHaveBeenCalledWith('/api/hermes/personal-autopilot/overview?profile=default')
})
```

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/client/personal-autopilot-api.test.ts --reporter=dot
```

Expected: FAIL because the API module does not exist.

**Step 3: Implement client API**

Create interfaces matching the server snapshot and:

```ts
export async function fetchPersonalAutopilotOverview(options: { profile?: string | null } = {}): Promise<PersonalAutopilotOverview> {
  const res = await request<{ overview: PersonalAutopilotOverview }>(withProfile('/api/hermes/personal-autopilot/overview', options.profile))
  return res.overview
}
```

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/client/personal-autopilot-api.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/client/src/api/hermes/personal-autopilot.ts tests/client/personal-autopilot-api.test.ts
git commit -m "feat: add personal autopilot client api"
```

### Task 4: Personal OS Command Center

**Files:**
- Modify: `packages/client/src/views/hermes/PersonalOSView.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/personal-os-view.test.ts`

**Step 1: Write failing view tests**

Mock `fetchPersonalAutopilotOverview` and assert:

```ts
expect(wrapper.text()).toContain('下一步')
expect(wrapper.text()).toContain('吃高蛋白早餐')
expect(wrapper.text()).toContain('查看完整计划')
expect(wrapper.html()).toContain('hermes.personalPlanning')
```

Also assert the page does not render the module grid as the primary content when autopilot data exists.

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts --reporter=dot
```

Expected: FAIL because `PersonalOSView` still renders a module overview.

**Step 3: Implement UI**

Update `PersonalOSView` to load both:

- `fetchPersonalStateOverview({ profile })`
- `fetchPersonalAutopilotOverview({ profile })`

Render:

- command center hero
- current autopilot mode
- one next action
- reason
- fallback action
- compact signal strip
- secondary links to Smart Planning and Health

Keep `SmartPlanningView` route unchanged. It becomes the detailed route behind "查看完整计划".

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts tests/client/personal-autopilot-api.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/client/src/views/hermes/PersonalOSView.vue packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts tests/client/personal-os-view.test.ts
git commit -m "feat: make personal os a command center"
```

### Task 5: Quick Log Endpoint

**Files:**
- Modify: `packages/server/src/services/hermes/personal-autopilot.ts`
- Modify: `packages/server/src/controllers/hermes/personal-autopilot.ts`
- Modify: `packages/server/src/routes/hermes/personal-autopilot.ts`
- Modify: `packages/client/src/api/hermes/personal-autopilot.ts`
- Test: `tests/server/personal-autopilot-service.test.ts`
- Test: `tests/server/personal-autopilot-controller.test.ts`
- Test: `tests/client/personal-autopilot-api.test.ts`

**Step 1: Write failing tests**

Service test:

```ts
expect(classifyQuickLog('午饭吃了鸡腿饭，加奶茶')).toBe('diet')
expect(classifyQuickLog('脸出油，鼻翼有点红')).toBe('skin')
expect(classifyQuickLog('胸肩练了40分钟')).toBe('body')
```

Client test:

```ts
await createPersonalAutopilotQuickLog({ text: '脸出油', kind: 'skin' }, 'default')
expect(request).toHaveBeenCalledWith('/api/hermes/personal-autopilot/quick-log?profile=default', {
  method: 'POST',
  body: JSON.stringify({ text: '脸出油', kind: 'skin' }),
})
```

**Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-service.test.ts tests/server/personal-autopilot-controller.test.ts tests/client/personal-autopilot-api.test.ts --reporter=dot
```

Expected: FAIL because quick log behavior does not exist.

**Step 3: Implement minimal quick log**

Add:

- `classifyQuickLog(text, explicitKind?)`
- `createPersonalAutopilotQuickLog(input, actor, profile)`

Initial persistence:

- diet logs call `createHealthFoodLog({ meal, notes: text, nutrition: {} })`
- body logs call `createHealthWorkout({ title: text, notes: text })`
- skin/recovery/order logs call `createHealthRecord({ kind, title, value: text, notes: text })`

This is intentionally conservative. Do not add LLM parsing in the first pass.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-service.test.ts tests/server/personal-autopilot-controller.test.ts tests/client/personal-autopilot-api.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/personal-autopilot.ts packages/server/src/controllers/hermes/personal-autopilot.ts packages/server/src/routes/hermes/personal-autopilot.ts packages/client/src/api/hermes/personal-autopilot.ts tests/server/personal-autopilot-service.test.ts tests/server/personal-autopilot-controller.test.ts tests/client/personal-autopilot-api.test.ts
git commit -m "feat: add personal autopilot quick logs"
```

### Task 6: Command Center Quick Log UI

**Files:**
- Modify: `packages/client/src/views/hermes/PersonalOSView.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/personal-os-view.test.ts`

**Step 1: Write failing view test**

Assert:

```ts
expect(wrapper.find('[data-test="autopilot-quick-log-input"]').exists()).toBe(true)
await wrapper.find('[data-test="autopilot-quick-log-input"] input').setValue('午饭吃了鸡腿饭')
await wrapper.find('[data-test="autopilot-quick-log-submit"]').trigger('click')
expect(createPersonalAutopilotQuickLog).toHaveBeenCalled()
```

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts --reporter=dot
```

Expected: FAIL because quick log UI does not exist.

**Step 3: Implement quick log UI**

Add a compact input below the next action:

- placeholder: "一句话记录饮食、训练、皮肤或状态"
- submit button
- loading state
- success message
- reload autopilot overview after submit

Do not build a large form.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts tests/client/personal-autopilot-api.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/client/src/views/hermes/PersonalOSView.vue packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts tests/client/personal-os-view.test.ts
git commit -m "feat: add personal os quick logging"
```

### Task 7: Focused Validation

**Files:**
- No code changes unless validation finds defects.

**Step 1: Run focused test suite**

Run:

```powershell
npx vitest run tests/server/personal-autopilot-service.test.ts tests/server/personal-autopilot-controller.test.ts tests/server/personal-autopilot-routes.test.ts tests/client/personal-autopilot-api.test.ts tests/client/personal-os-view.test.ts tests/client/smart-planning-view.test.ts tests/server/health-state-service.test.ts tests/server/personal-state-service.test.ts --reporter=dot
```

Expected: PASS.

**Step 2: Run type checks**

Run:

```powershell
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
```

Expected: PASS.

**Step 3: Manual browser check**

Start dev servers:

```powershell
npm run dev
```

Open:

```text
http://localhost:8649/#/hermes/personal-os
```

Confirm:

- Personal OS first screen shows the command center.
- It displays one next best action.
- Smart Planning is accessible as a secondary detailed route.
- Quick log accepts a one-sentence entry and refreshes the command center.

**Step 4: Commit validation fixes if needed**

If validation reveals a defect, write or adjust a failing test first, implement the fix, rerun the focused tests, and commit only the fix.
