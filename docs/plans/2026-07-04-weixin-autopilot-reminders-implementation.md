# Weixin Autopilot Reminders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add personal Weixin proactive reminders for Personal Autopilot, using existing iLink Weixin credentials and sending only rate-limited next-best-action reminders.

**Architecture:** Add a profile-scoped reminder service with settings, delivery logs, anti-spam policy, and a narrow Weixin sender interface. Expose settings, deliveries, and test send through Koa routes. Start a conservative server-side checker that periodically reads Personal Autopilot and sends Weixin reminders when policy allows.

**Tech Stack:** TypeScript, Koa, node:sqlite, existing Hermes profile/config helpers, axios, Vue 3, Vitest.

---

### Task 1: Reminder Store And Policy

**Files:**
- Create: `packages/server/src/services/hermes/autopilot-reminders.ts`
- Test: `tests/server/autopilot-reminders-service.test.ts`

**Step 1: Write failing tests**

Create tests for settings defaults, quiet hours, daily limits, duplicate action detection, and minimum interval.

```ts
import { describe, expect, it } from 'vitest'
import {
  defaultReminderSettings,
  evaluateReminderPolicy,
  formatAutopilotReminderMessage,
} from '../../packages/server/src/services/hermes/autopilot-reminders'

describe('autopilot reminder policy', () => {
  it('defaults to disabled weixin reminders', () => {
    expect(defaultReminderSettings('default')).toMatchObject({
      profile: 'default',
      enabled: false,
      channel: 'weixin',
      dailyLimit: 5,
      minimumIntervalMinutes: 60,
      quietStart: '23:30',
      quietEnd: '08:00',
    })
  })

  it('skips disabled settings', () => {
    const decision = evaluateReminderPolicy({
      now: new Date('2026-07-04T12:00:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: false },
      autopilot: { mode: 'nudge', nextAction: { id: 'a1', title: '吃午饭', reason: '饭点到了', fallbackTitle: '鸡胸肉' } },
      deliveriesToday: [],
    } as any)
    expect(decision).toMatchObject({ shouldSend: false, reason: 'disabled' })
  })

  it('skips quiet hours that cross midnight', () => {
    const decision = evaluateReminderPolicy({
      now: new Date('2026-07-04T23:45:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: true },
      autopilot: { mode: 'nudge', nextAction: { id: 'a1', title: '睡前收束', reason: '太晚了', fallbackTitle: '洗脸关灯' } },
      deliveriesToday: [],
    } as any)
    expect(decision).toMatchObject({ shouldSend: false, reason: 'quiet_hours' })
  })

  it('formats one action-focused message', () => {
    expect(formatAutopilotReminderMessage({
      title: '睡前收束',
      reason: '恢复是今天的限制因素',
      fallbackTitle: '洗脸 + 关灯',
    })).toBe('现在最该做：睡前收束\n原因：恢复是今天的限制因素\n保底：洗脸 + 关灯')
  })
})
```

**Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-service.test.ts --reporter=dot
```

Expected: FAIL because `autopilot-reminders.ts` does not exist.

**Step 3: Implement minimal store and policy**

Implement:

- `ReminderSettings`
- `ReminderDelivery`
- `defaultReminderSettings(profile)`
- `getAutopilotReminderDbPath(profile)`
- `initAutopilotReminderDb(profile)`
- `getReminderSettings(profile)`
- `updateReminderSettings(profile, patch)`
- `listRecentReminderDeliveries(profile, limit)`
- `recordReminderDelivery(profile, delivery)`
- `evaluateReminderPolicy(input)`
- `formatAutopilotReminderMessage(action)`

Use a SQLite DB named `autopilot_reminders.db` under the same profile directory pattern used by existing profile-scoped services.

Policy rules:

- disabled -> skip `disabled`
- `mode === 'silent'` -> skip `silent_mode`
- quiet hours -> skip `quiet_hours`
- same `action_id` already sent today -> skip `duplicate_action`
- sent count today >= daily limit -> skip `daily_limit`
- last sent within minimum interval -> skip `minimum_interval`
- otherwise send

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-service.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/autopilot-reminders.ts tests/server/autopilot-reminders-service.test.ts
git commit -m "feat: add autopilot reminder policy"
```

### Task 2: Weixin Sender

**Files:**
- Create: `packages/server/src/services/hermes/weixin-sender.ts`
- Test: `tests/server/weixin-sender.test.ts`

**Step 1: Write failing tests**

Mock credential resolution and axios.

Test cases:

- Missing credentials returns `{ ok: false, error: 'missing_weixin_credentials' }`.
- Sender posts text message to configured `WEIXIN_BASE_URL`.
- Sender uses default iLink base URL if no base URL exists.

Use a narrow exported function:

```ts
sendWeixinTextReminder(profile: string, message: string): Promise<{ ok: boolean; error?: string }>
```

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/server/weixin-sender.test.ts --reporter=dot
```

Expected: FAIL because `weixin-sender.ts` does not exist.

**Step 3: Implement sender**

Implement a sender that:

- Reads profile-scoped env values with existing config/profile helpers.
- Requires `WEIXIN_ACCOUNT_ID` and `WEIXIN_TOKEN`.
- Uses `WEIXIN_BASE_URL` if configured, otherwise a default base URL constant.
- Calls a single isolated HTTP request function.

If the exact iLink outbound endpoint is uncertain, isolate it in:

```ts
function buildWeixinSendUrl(baseUrl: string): string
```

and test the expected URL. Keep the caller stable so endpoint adjustment is localized.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/weixin-sender.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/weixin-sender.ts tests/server/weixin-sender.test.ts
git commit -m "feat: add weixin reminder sender"
```

### Task 3: Reminder Dispatch Service

**Files:**
- Modify: `packages/server/src/services/hermes/autopilot-reminders.ts`
- Test: `tests/server/autopilot-reminders-dispatch.test.ts`

**Step 1: Write failing dispatch tests**

Mock:

- `getPersonalAutopilotOverview`
- `sendWeixinTextReminder`

Assert:

- Sends when policy allows.
- Records `sent` delivery with message and action id.
- Records `skipped` delivery for disabled, quiet hours, and duplicate.
- Records `failed` delivery when Weixin sender fails.

Target API:

```ts
dispatchAutopilotReminder({ profile, now }): Promise<ReminderDispatchResult>
```

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-dispatch.test.ts --reporter=dot
```

Expected: FAIL because dispatch does not exist.

**Step 3: Implement dispatch**

Implement:

- Load settings.
- Load autopilot overview.
- Load today's deliveries.
- Evaluate policy.
- If skipped, record one `skipped` delivery for observability.
- If allowed, format message and call Weixin sender.
- Record `sent` or `failed`.

Do not throw on normal send failures; return structured result.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-service.test.ts tests/server/autopilot-reminders-dispatch.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/autopilot-reminders.ts tests/server/autopilot-reminders-dispatch.test.ts
git commit -m "feat: dispatch autopilot weixin reminders"
```

### Task 4: Reminder API

**Files:**
- Create: `packages/server/src/controllers/hermes/autopilot-reminders.ts`
- Create: `packages/server/src/routes/hermes/autopilot-reminders.ts`
- Modify: `packages/server/src/routes/index.ts`
- Test: `tests/server/autopilot-reminders-controller.test.ts`
- Test: `tests/server/autopilot-reminders-routes.test.ts`

**Step 1: Write failing controller and route tests**

Routes should include:

- `GET /api/hermes/autopilot-reminders/settings`
- `PUT /api/hermes/autopilot-reminders/settings`
- `GET /api/hermes/autopilot-reminders/deliveries`
- `POST /api/hermes/autopilot-reminders/test`

Controller tests should verify:

- Reads profile from query or request state.
- Returns settings.
- Updates settings.
- Lists recent deliveries.
- Test endpoint calls dispatch with `force: true` or sends a test message through the same sender path.
- Profile access is denied for unavailable profiles, matching existing health-state behavior.

**Step 2: Run tests to verify failure**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-controller.test.ts tests/server/autopilot-reminders-routes.test.ts --reporter=dot
```

Expected: FAIL because controller and routes do not exist.

**Step 3: Implement API**

Implement the controller thinly:

- Delegate business logic to `autopilot-reminders.ts`.
- Reuse profile access guard pattern from `health-state.ts`.
- Return JSON only.

Register the route in `packages/server/src/routes/index.ts` before proxy catch-all routes.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-controller.test.ts tests/server/autopilot-reminders-routes.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/server/src/controllers/hermes/autopilot-reminders.ts packages/server/src/routes/hermes/autopilot-reminders.ts packages/server/src/routes/index.ts tests/server/autopilot-reminders-controller.test.ts tests/server/autopilot-reminders-routes.test.ts
git commit -m "feat: expose autopilot reminder api"
```

### Task 5: Periodic Checker

**Files:**
- Modify: `packages/server/src/services/hermes/autopilot-reminders.ts`
- Modify: `packages/server/src/main.ts` or the existing server bootstrap file that starts background services
- Test: `tests/server/autopilot-reminders-scheduler.test.ts`

**Step 1: Locate server bootstrap**

Read the server entry file and existing background service startup patterns before editing. Use the smallest existing hook.

**Step 2: Write failing scheduler tests**

Test:

- Scheduler does not start when disabled by env flag.
- Scheduler calls dispatch for enabled profiles on interval.
- Scheduler can be stopped cleanly.

Target API:

```ts
startAutopilotReminderScheduler(): { stop: () => void }
```

**Step 3: Run test to verify failure**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-scheduler.test.ts --reporter=dot
```

Expected: FAIL because scheduler does not exist.

**Step 4: Implement scheduler**

Rules:

- Default interval: 10 minutes.
- Env override: `HERMES_AUTOPILOT_REMINDER_INTERVAL_MS`.
- Env disable: `HERMES_AUTOPILOT_REMINDERS_DISABLED=1`.
- Enumerate profiles conservatively from disk.
- Dispatch only profiles with enabled reminder settings.
- Catch and log errors; do not crash the server.

Wire into server bootstrap only after tests cover stop behavior.

**Step 5: Run tests**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-scheduler.test.ts tests/server/autopilot-reminders-dispatch.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add packages/server/src/services/hermes/autopilot-reminders.ts packages/server/src/main.ts tests/server/autopilot-reminders-scheduler.test.ts
git commit -m "feat: schedule autopilot reminders"
```

If the bootstrap file is not `packages/server/src/main.ts`, stage the actual file touched instead.

### Task 6: Client API

**Files:**
- Create: `packages/client/src/api/hermes/autopilot-reminders.ts`
- Test: `tests/client/autopilot-reminders-api.test.ts`

**Step 1: Write failing client API tests**

Test:

- Fetch settings with profile query.
- Update settings with JSON body.
- List deliveries.
- Send test reminder.

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/client/autopilot-reminders-api.test.ts --reporter=dot
```

Expected: FAIL because client API module does not exist.

**Step 3: Implement client API**

Export:

- `fetchAutopilotReminderSettings(profile?)`
- `updateAutopilotReminderSettings(payload, profile?)`
- `fetchAutopilotReminderDeliveries(profile?)`
- `sendAutopilotReminderTest(profile?)`

Use the existing `request` helper.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/client/autopilot-reminders-api.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/client/src/api/hermes/autopilot-reminders.ts tests/client/autopilot-reminders-api.test.ts
git commit -m "feat: add autopilot reminder client api"
```

### Task 7: Settings UI

**Files:**
- Modify: `packages/client/src/views/hermes/PersonalOSView.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/personal-os-view.test.ts`

**Step 1: Write failing UI tests**

Mock reminder API and assert:

- The command center shows Weixin reminder status.
- There is an enable switch.
- There is a test send button.
- Updating the switch calls `updateAutopilotReminderSettings`.
- Test button calls `sendAutopilotReminderTest`.

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts --reporter=dot
```

Expected: FAIL because reminder controls do not exist.

**Step 3: Implement UI**

Add a compact reminder control section to Personal OS command center:

- Weixin reminder enabled switch.
- Quiet hours summary.
- Daily limit summary.
- Test reminder button.
- Last delivery status if available.

Do not add a full rule-builder UI.

**Step 4: Run tests**

Run:

```powershell
npx vitest run tests/client/personal-os-view.test.ts tests/client/autopilot-reminders-api.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add packages/client/src/views/hermes/PersonalOSView.vue packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts tests/client/personal-os-view.test.ts
git commit -m "feat: add weixin reminder controls"
```

### Task 8: Focused Validation

**Files:**
- No code changes unless validation finds defects.

**Step 1: Run focused test suite**

Run:

```powershell
npx vitest run tests/server/autopilot-reminders-service.test.ts tests/server/autopilot-reminders-dispatch.test.ts tests/server/autopilot-reminders-controller.test.ts tests/server/autopilot-reminders-routes.test.ts tests/server/autopilot-reminders-scheduler.test.ts tests/server/weixin-sender.test.ts tests/client/autopilot-reminders-api.test.ts tests/client/personal-os-view.test.ts tests/server/weixin-controller.test.ts --reporter=dot
```

Expected: PASS.

**Step 2: Run type checks**

Run:

```powershell
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
```

Expected: PASS.

**Step 3: Manual integration check**

Start dev server:

```powershell
npm run dev
```

Open:

```text
http://localhost:8649/#/hermes/personal-os
```

Verify:

- Weixin credentials can still be scanned/saved through existing settings flow.
- Personal OS shows reminder controls.
- Test reminder attempts delivery and writes a delivery record.
- Enabling reminders does not send during quiet hours.
- Re-triggering the same action does not duplicate the reminder.

**Step 4: Commit validation fixes if needed**

If validation reveals a defect, write or adjust a failing test first, implement the fix, rerun focused tests, and commit only the fix.
