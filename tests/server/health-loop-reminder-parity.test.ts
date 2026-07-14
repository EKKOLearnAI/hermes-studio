import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getPersonalAutopilotOverview = vi.hoisted(() => vi.fn())
const sendWeixinTextReminder = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/personal-autopilot', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/services/hermes/personal-autopilot')>(),
  getPersonalAutopilotOverview,
}))
vi.mock('../../packages/server/src/services/hermes/weixin-sender', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/services/hermes/weixin-sender')>(),
  sendWeixinTextReminder,
}))

import { defaultReminderSettings, enqueueAutopilotReminder, evaluateReminderPolicy,
  updateReminderSettings } from '../../packages/server/src/services/hermes/autopilot-reminders'
import { reminderMessageCodeForAction } from '../../packages/server/src/services/hermes/personal-autopilot'
import { listFabricWorkflows, getFabricWorkflow, withActionFabricDb } from '../../packages/server/src/services/hermes/action-fabric'
import { startHealthLoopRuntime, stopHealthLoopRuntime } from '../../packages/server/src/services/hermes/health-loop/runtime'

const recorded = [
  { domain: 'diet', mode: 'nudge', enabled: true, expected: 'send', code: 'meal_due' },
  { domain: 'recovery', mode: 'nudge', enabled: true, expected: 'send', code: 'recovery_check' },
  { domain: 'body', mode: 'silent', enabled: true, expected: 'silent_mode', code: 'training_adjustment' },
  { domain: 'planning', mode: 'nudge', enabled: false, expected: 'disabled', code: 'recovery_check' },
] as const

describe('legacy reminder to health-loop shadow parity', () => {
  it.each(recorded)('keeps the recorded $domain/$mode decision and emits only supported semantics', scenario => {
    const action = { id: `action-${scenario.domain}`, domain: scenario.domain, title: 'legacy title',
      reason: 'legacy reason', fallbackTitle: 'legacy fallback' }
    const decision = evaluateReminderPolicy({ now: new Date('2026-07-04T12:00:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: scenario.enabled },
      autopilot: { mode: scenario.mode, nextAction: action }, deliveriesToday: [] } as any)

    expect(decision.reason).toBe(scenario.expected)
    expect(reminderMessageCodeForAction(action)).toBe(scenario.code)
  })

  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''

  afterEach(async () => {
    await stopHealthLoopRuntime()
    vi.clearAllMocks()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    if (home) rmSync(home, { recursive: true, force: true })
    home = ''
  })

  it('lets the initialized runtime enqueue a real sandbox reminder workflow without a direct send path', async () => {
    home = mkdtempSync(join(tmpdir(), 'hwui-health-reminder-parity-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'health-reminder-parity-managed-key-32-bytes'
    getPersonalAutopilotOverview.mockReturnValue({ mode: 'nudge', nextAction: {
      id: 'action-meal-due', domain: 'diet', title: '吃午饭', reason: '饭点到了', fallbackTitle: '吃鸡胸肉',
    } })
    updateReminderSettings('default', { enabled: true })
    await startHealthLoopRuntime()

    const result = await enqueueAutopilotReminder({
      profile: 'default', now: new Date('2026-07-14T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'sent', reason: 'send' })
    expect(sendWeixinTextReminder).not.toHaveBeenCalled()
    const workflow = listFabricWorkflows({ capabilityId: 'health.reminder.send', limit: 10 })[0]
    expect(workflow).toMatchObject({ executorId: 'health-shadow' })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      intent: { capabilityId: 'health.reminder.send' },
      policyDecision: { outcome: 'allow', policySnapshot: { environments: ['sandbox'], resolvedEnvironment: 'sandbox' } },
    })
    const persistedInput = withActionFabricDb(db => db.prepare(`SELECT i.capability_version,i.input_json
      FROM fabric_action_intents i JOIN fabric_workflows w ON w.intent_id=i.id WHERE w.id=?`).get(workflow.id) as
      { capability_version: number; input_json: string })
    expect(persistedInput.capability_version).toBe(2)
    expect(JSON.parse(persistedInput.input_json)).toMatchObject({ redacted: true,
      fields: expect.arrayContaining(['schemaVersion', 'messageCode']) })
  })
})
