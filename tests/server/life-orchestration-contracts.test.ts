import { describe, expect, it } from 'vitest'
import {
  LIFE_ACCOUNT_HEALTH,
  LIFE_CANCELLATION_STATES,
  LIFE_EXECUTION_MODES,
  LIFE_HANDOFF_KINDS,
  LIFE_HOLD_STATES,
  LIFE_OPTION_KINDS,
  LIFE_PLAN_STATES,
  LIFE_SOURCE_KINDS,
  LIFE_SUBSCRIPTION_STATES,
  assertLifeSafeData,
  isLifePrivateText,
  isLegalLifeCancellationTransition,
  isLegalLifeHandoffTransition,
  isLegalLifeHoldTransition,
  isLegalLifePlanTransition,
  isLifeTimezone,
  lifeModeAllowsExternalWrite,
  parseLifeMoney,
  parseLifeTimeWindow,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life and entertainment orchestration contracts', () => {
  it('keeps source, mode, option, subscription, plan, hold, cancellation, and handoff enums closed', () => {
    expect(LIFE_SOURCE_KINDS).toEqual(['calendar', 'contacts', 'travel', 'music', 'games', 'subscriptions'])
    expect(LIFE_EXECUTION_MODES).toEqual(['observe', 'shadow', 'live'])
    expect(LIFE_ACCOUNT_HEALTH).toContain('revoked')
    expect(LIFE_OPTION_KINDS).toEqual(['travel', 'video', 'music', 'game'])
    expect(LIFE_SUBSCRIPTION_STATES).toContain('cancel_pending')
    expect(LIFE_PLAN_STATES).toContain('superseded')
    expect(LIFE_HOLD_STATES).toContain('lookup_required')
    expect(LIFE_CANCELLATION_STATES).toContain('waiting_user')
    expect(LIFE_HANDOFF_KINDS).toEqual(['commerce', 'internet', 'android'])
  })

  it('accepts only exact currency and safe integer minor units', () => {
    expect(parseLifeMoney({ currency: 'CNY', amountMinor: 12_300 }))
      .toEqual({ currency: 'CNY', amountMinor: 12_300 })
    for (const value of [{ currency: 'cny', amountMinor: 1 }, { currency: 'CNY', amountMinor: -1 },
      { currency: 'CNY', amountMinor: 1.2 }, { currency: 'CNY', amountMinor: 1, formatted: '¥0.01' }, null]) {
      expect(() => parseLifeMoney(value)).toThrow('LIFE_MONEY_INVALID')
    }
  })

  it('requires canonical bounded time windows and valid IANA timezones', () => {
    expect(parseLifeTimeWindow({ startsAt: '2026-07-15T10:00:00.000Z', endsAt: '2026-07-15T11:00:00.000Z' }))
      .toEqual({ startsAt: '2026-07-15T10:00:00.000Z', endsAt: '2026-07-15T11:00:00.000Z' })
    expect(() => parseLifeTimeWindow({ startsAt: 'not-time', endsAt: '2026-07-15T11:00:00.000Z' }))
      .toThrow('LIFE_TIME_WINDOW_INVALID')
    expect(() => parseLifeTimeWindow({ startsAt: '2026-07-15T11:00:00.000Z', endsAt: '2026-07-15T10:00:00.000Z' }))
      .toThrow('LIFE_TIME_WINDOW_INVALID')
    expect(isLifeTimezone('Asia/Shanghai')).toBe(true)
    expect(isLifeTimezone('Mars/Olympus')).toBe(false)
  })

  it('makes observe and shadow physically incapable of external writes', () => {
    expect(lifeModeAllowsExternalWrite('observe')).toBe(false)
    expect(lifeModeAllowsExternalWrite('shadow')).toBe(false)
    expect(lifeModeAllowsExternalWrite('live')).toBe(true)
  })

  it('allows only explicit monotonic plan and write transitions', () => {
    expect(isLegalLifePlanTransition('proposed', 'reserved')).toBe(true)
    expect(isLegalLifePlanTransition('reserved', 'completed')).toBe(true)
    expect(isLegalLifePlanTransition('completed', 'proposed')).toBe(false)
    expect(isLegalLifeHoldTransition('submitting', 'lookup_required')).toBe(true)
    expect(isLegalLifeHoldTransition('cancelled', 'confirmed')).toBe(false)
    expect(isLegalLifeCancellationTransition('submitting', 'processing')).toBe(true)
    expect(isLegalLifeCancellationTransition('cancelled', 'requested')).toBe(false)
    expect(isLegalLifeHandoffTransition('proposed', 'accepted')).toBe(true)
    expect(isLegalLifeHandoffTransition('accepted', 'cancelled')).toBe(false)
  })

  it('rejects secrets, credential-shaped values, sparse arrays, accessors, proxies, and oversized data', () => {
    expect(() => assertLifeSafeData({ planId: 'plan-1', reasonCodes: ['schedule_fit'], amountMinor: 100 }))
      .not.toThrow()
    expect(() => assertLifeSafeData({ sessions: [{ optionId: 'option-1' }] })).not.toThrow()
    for (const value of [{ accessToken: 'hidden' }, { email: 'hidden' }, { label: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      { value: Number.NaN }, { text: 'x'.repeat(2_001) }, Array.from({ length: 65 }, () => 'x')]) {
      expect(() => assertLifeSafeData(value)).toThrow(/LIFE_/)
    }
    const sparse = new Array(2); sparse[1] = 'x'
    expect(() => assertLifeSafeData(sparse)).toThrow('LIFE_DATA_BOUNDS_EXCEEDED')
    let invoked = false
    const accessor = Object.defineProperty(['safe'], '0', { enumerable: true,
      get: () => { invoked = true; return 'unsafe' } })
    expect(() => assertLifeSafeData(accessor)).toThrow('LIFE_DATA_BOUNDS_EXCEEDED')
    expect(invoked).toBe(false)
    expect(() => assertLifeSafeData(new Proxy({ planId: 'plan-1' }, {}))).toThrow('LIFE_DATA_INVALID')
  })

  it('rejects raw contact channels, locations, provider primitives, and camel-case execution primitives', () => {
    expect(() => assertLifeSafeData({ observedAt: '2026-07-15T10:00:00.000Z',
      alias: 'Friend A', source: 'virtual-games' })).not.toThrow()
    for (const value of [{ alias: 'person@example.com' }, { label: '+8613800138000' },
      { source: 'https://provider.example/private' }, { location: '31.2304, 121.4737' },
      { alias: '@private_handle' }]) {
      expect(() => assertLifeSafeData(value)).toThrow('LIFE_SENSITIVE_VALUE_FORBIDDEN')
    }
    for (const value of [{ selector: '.buy' }, { provider_url: 'virtual-provider' },
      { providerURL: 'virtual-provider' }, { coordinates: [31, 121] }, { androidScript: 'tap' }]) {
      expect(() => assertLifeSafeData(value)).toThrow('LIFE_RAW_PRIMITIVE_FORBIDDEN')
    }
    expect(isLifePrivateText('Friend A')).toBe(false)
    expect(isLifePrivateText('person@example.com')).toBe(true)
    expect(isLifePrivateText('+8613800138000')).toBe(true)
    expect(isLifePrivateText('https://provider.example')).toBe(true)
    expect(isLifePrivateText('31.2304, 121.4737')).toBe(true)
  })
})
