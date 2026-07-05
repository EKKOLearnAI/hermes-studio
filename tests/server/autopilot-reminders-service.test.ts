import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultReminderSettings,
  evaluateReminderPolicy,
  formatAutopilotReminderMessage,
  getReminderSettings,
  listRecentReminderDeliveries,
  recordReminderDelivery,
  updateReminderSettings,
} from '../../packages/server/src/services/hermes/autopilot-reminders'

const originalHermesHome = process.env.HERMES_HOME
let hermesHome = ''

function action(id = 'a1') {
  return {
    id,
    title: '吃午饭',
    reason: '饭点到了',
    fallbackTitle: '鸡胸肉',
  }
}

function autopilot(mode = 'nudge', actionId = 'a1') {
  return { mode, nextAction: action(actionId) }
}

describe('autopilot reminder policy', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-autopilot-reminders-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

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

  it('persists settings and delivery attempts in the profile store', () => {
    const settings = updateReminderSettings('default', { enabled: true, dailyLimit: 3 })
    recordReminderDelivery('default', {
      channel: 'weixin',
      mode: 'nudge',
      actionId: 'a1',
      actionTitle: '吃午饭',
      message: '现在最该做：吃午饭',
      status: 'sent',
      sentAt: '2026-07-04T12:00:00.000Z',
    })

    expect(settings).toMatchObject({ enabled: true, dailyLimit: 3 })
    expect(getReminderSettings('default')).toMatchObject({ enabled: true, dailyLimit: 3 })
    expect(listRecentReminderDeliveries('default', 1)[0]).toMatchObject({
      profile: 'default',
      status: 'sent',
      actionId: 'a1',
    })
  })

  it('skips disabled settings', () => {
    const decision = evaluateReminderPolicy({
      now: new Date('2026-07-04T12:00:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: false },
      autopilot: autopilot(),
      deliveriesToday: [],
    } as any)

    expect(decision).toMatchObject({ shouldSend: false, reason: 'disabled' })
  })

  it('skips quiet hours that cross midnight', () => {
    const decision = evaluateReminderPolicy({
      now: new Date('2026-07-04T23:45:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: true },
      autopilot: autopilot('nudge', 'sleep'),
      deliveriesToday: [],
    } as any)

    expect(decision).toMatchObject({ shouldSend: false, reason: 'quiet_hours' })
  })

  it('skips silent mode, duplicate actions, daily limits, and minimum intervals', () => {
    const settings = { ...defaultReminderSettings('default'), enabled: true, dailyLimit: 1, minimumIntervalMinutes: 60 }
    const now = new Date('2026-07-04T12:00:00+08:00')
    const recentDelivery = {
      id: 'd1',
      profile: 'default',
      channel: 'weixin',
      mode: 'nudge',
      actionId: 'a1',
      actionTitle: '吃午饭',
      message: 'message',
      status: 'sent',
      error: null,
      sentAt: '2026-07-04T03:30:00.000Z',
      createdAt: '2026-07-04T03:30:00.000Z',
    }

    expect(evaluateReminderPolicy({ now, settings, autopilot: autopilot('silent'), deliveriesToday: [] } as any))
      .toMatchObject({ shouldSend: false, reason: 'silent_mode' })
    expect(evaluateReminderPolicy({ now, settings, autopilot: autopilot('nudge', 'a1'), deliveriesToday: [recentDelivery] } as any))
      .toMatchObject({ shouldSend: false, reason: 'duplicate_action' })
    expect(evaluateReminderPolicy({ now, settings, autopilot: autopilot('nudge', 'a2'), deliveriesToday: [recentDelivery] } as any))
      .toMatchObject({ shouldSend: false, reason: 'daily_limit' })
    expect(evaluateReminderPolicy({
      now,
      settings: { ...settings, dailyLimit: 5 },
      autopilot: autopilot('nudge', 'a2'),
      deliveriesToday: [recentDelivery],
    } as any)).toMatchObject({ shouldSend: false, reason: 'minimum_interval' })
  })

  it('allows action reminders when policy constraints pass', () => {
    const decision = evaluateReminderPolicy({
      now: new Date('2026-07-04T12:00:00+08:00'),
      settings: { ...defaultReminderSettings('default'), enabled: true },
      autopilot: autopilot('nudge', 'a1'),
      deliveriesToday: [],
    } as any)

    expect(decision).toMatchObject({ shouldSend: true, reason: 'send' })
  })

  it('formats one action-focused message', () => {
    expect(formatAutopilotReminderMessage({
      title: '睡前收束',
      reason: '恢复是今天的限制因素',
      fallbackTitle: '洗脸 + 关灯',
    })).toBe('现在最该做：睡前收束\n原因：恢复是今天的限制因素\n保底：洗脸 + 关灯')
  })
})
