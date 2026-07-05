import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const getAutopilotOverview = vi.hoisted(() => vi.fn())
const sendWeixinTextReminder = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/personal-autopilot', () => ({
  getPersonalAutopilotOverview: getAutopilotOverview,
}))

vi.mock('../../packages/server/src/services/hermes/weixin-sender', () => ({
  sendWeixinTextReminder,
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
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('sends and records an action reminder when policy allows', async () => {
    updateReminderSettings('default', { enabled: true })

    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'sent', reason: 'send' })
    expect(sendWeixinTextReminder).toHaveBeenCalledWith(
      'default',
      '现在最该做：吃高蛋白午饭\n原因：饭点到了，先稳住饮食。\n保底：便利店买鸡胸肉',
    )
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

  it('records failed deliveries without throwing when Weixin delivery fails', async () => {
    updateReminderSettings('default', { enabled: true })
    sendWeixinTextReminder.mockResolvedValueOnce({ ok: false, error: 'missing_weixin_credentials' })

    const result = await dispatchAutopilotReminder({
      profile: 'default',
      now: new Date('2026-07-04T12:00:00+08:00'),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'missing_weixin_credentials' })
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      status: 'failed',
      error: 'missing_weixin_credentials',
    })
  })
})
