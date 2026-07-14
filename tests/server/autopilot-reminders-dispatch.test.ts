import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const getAutopilotOverview = vi.hoisted(() => vi.fn())
const sendWeixinTextReminder = vi.hoisted(() => vi.fn())
const createFabricIntent = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/personal-autopilot', () => ({
  getPersonalAutopilotOverview: getAutopilotOverview,
  reminderMessageCodeForAction: (action: { domain?: string }) => action.domain === 'body'
    ? 'training_adjustment' : action.domain === 'recovery' ? 'recovery_check' : 'meal_due',
}))

vi.mock('../../packages/server/src/services/hermes/weixin-sender', () => ({
  sendWeixinTextReminder,
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric/workflows', () => ({
  createFabricIntent,
}))

import {
  dispatchAutopilotReminder,
  listRecentReminderDeliveries,
  recordReminderDelivery,
  updateReminderSettings,
} from '../../packages/server/src/services/hermes/autopilot-reminders'

const originalHermesHome = process.env.HERMES_HOME
let hermesHome = ''

function mockAutopilot(actionId = 'action-lunch') {
  getAutopilotOverview.mockReturnValue({
    mode: 'nudge',
    nextAction: {
      id: actionId,
      title: '吃高蛋白午饭',
      reason: '饭点到了，先稳住饮食。',
      fallbackTitle: '便利店买鸡胸肉',
      domain: 'diet',
    },
  })
}

describe('autopilot reminder dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-autopilot-reminder-dispatch-'))
    process.env.HERMES_HOME = hermesHome
    mockAutopilot()
    sendWeixinTextReminder.mockResolvedValue({ ok: true })
    createFabricIntent.mockImplementation((input) => ({
      intent: { id: 'intent-reminder', ...input },
      policyDecision: { outcome: 'allow' },
      workflow: { id: 'workflow-reminder', state: 'preparing', executorId: 'health-shadow' },
    }))
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('enqueues and records a sandbox Fabric reminder when policy allows without direct delivery', async () => {
    updateReminderSettings('default', { enabled: true })

    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'sent', reason: 'send' })
    expect(sendWeixinTextReminder).not.toHaveBeenCalled()
    expect(createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'health.reminder.send',
      environments: ['sandbox'],
      target: { kind: 'health_recipient', recipient: 'configured-self' },
      input: { schemaVersion: 2, actionId: 'action-lunch', recipient: 'configured-self', messageCode: 'meal_due' },
      constraints: expect.objectContaining({
        legacyReminderDeliveryId: expect.stringMatching(/^autopilot-reminder-[a-f0-9]{32}$/),
      }),
    }))
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      status: 'sent',
      actionId: 'action-lunch',
      actionTitle: '吃高蛋白午饭',
    })
  })

  it('records skipped deliveries when reminders are disabled', async () => {
    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(sendWeixinTextReminder).not.toHaveBeenCalled()
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      status: 'skipped',
      error: 'disabled',
    })
  })

  it('records skipped deliveries for duplicate actions', async () => {
    updateReminderSettings('default', { enabled: true })
    recordReminderDelivery('default', {
      channel: 'weixin',
      mode: 'nudge',
      actionId: 'action-lunch',
      actionTitle: '吃高蛋白午饭',
      message: 'sent earlier',
      status: 'sent',
      sentAt: '2026-07-04T02:00:00.000Z',
    })

    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'skipped', reason: 'duplicate_action' })
    expect(sendWeixinTextReminder).not.toHaveBeenCalled()
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      status: 'skipped',
      error: 'duplicate_action',
    })
  })

  it('records a failed compatibility delivery when Fabric rejects the semantic intent', async () => {
    updateReminderSettings('default', { enabled: true })
    createFabricIntent.mockReturnValueOnce({
      intent: { id: 'intent-denied' }, policyDecision: { outcome: 'deny', reasonCodes: ['FABRIC_ROLE_CAPABILITY_DENIED'] },
      workflow: { id: 'workflow-denied', state: 'denied', executorId: null },
    })

    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'fabric_denied' })
    expect(sendWeixinTextReminder).not.toHaveBeenCalled()
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      status: 'failed',
      error: 'fabric_denied',
    })
  })

  it('uses stable Fabric and legacy identities across retries without duplicate history rows', async () => {
    updateReminderSettings('default', { enabled: true })
    const now = new Date('2026-07-04T12:00:00+08:00')

    const first = await dispatchAutopilotReminder({ profile: 'default', now, force: true })
    const second = await dispatchAutopilotReminder({ profile: 'default', now, force: true })

    expect(createFabricIntent).toHaveBeenCalledTimes(2)
    const [firstIntent, secondIntent] = createFabricIntent.mock.calls.map(call => call[0])
    expect(secondIntent.idempotencyKey).toBe(firstIntent.idempotencyKey)
    expect(secondIntent.constraints.legacyReminderDeliveryId)
      .toBe(firstIntent.constraints.legacyReminderDeliveryId)
    expect(second.delivery.id).toBe(first.delivery.id)
    expect(listRecentReminderDeliveries('default', 100)).toHaveLength(1)
  })

  it('never promotes a legacy enabled flag to production delivery', async () => {
    updateReminderSettings('default', { enabled: true })
    await dispatchAutopilotReminder({ profile: 'default', now: new Date('2026-07-04T12:00:00+08:00') })
    expect(createFabricIntent.mock.calls[0][0].environments).toEqual(['sandbox'])
  })

  it('hashes hostile legacy action identity out of persisted Fabric metadata', async () => {
    updateReminderSettings('default', { enabled: true })
    mockAutopilot('../private/password=do-not-persist')

    await dispatchAutopilotReminder({ profile: 'default', now: new Date('2026-07-04T12:00:00+08:00') })

    const intent = createFabricIntent.mock.calls[0][0]
    expect(intent.input.actionId).toMatch(/^legacy-action-[a-f0-9]{64}$/)
    expect(JSON.stringify({ input: intent.input, constraints: intent.constraints, idempotencyKey: intent.idempotencyKey }))
      .not.toContain('do-not-persist')
    expect(intent.constraints.legacyReminderDeliveryId.length).toBeLessThanOrEqual(64)
  })
})
