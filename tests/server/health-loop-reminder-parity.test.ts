import { describe, expect, it } from 'vitest'
import { defaultReminderSettings, evaluateReminderPolicy } from '../../packages/server/src/services/hermes/autopilot-reminders'
import { reminderMessageCodeForAction } from '../../packages/server/src/services/hermes/personal-autopilot'

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
})
