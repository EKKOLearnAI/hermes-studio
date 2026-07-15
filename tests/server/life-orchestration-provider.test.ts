import { describe, expect, it } from 'vitest'
import {
  assertLifeProviderResult,
  VirtualLifeSourceProvider,
  type LifeSourceKind,
  type VirtualLifeCatalogRecord,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('virtual life source adapters', () => {
  it('provides bounded deterministic pages for all six source kinds', async () => {
    for (const sourceKind of ['calendar', 'contacts', 'travel', 'music', 'games', 'subscriptions'] as const) {
      const adapter = provider(sourceKind)
      const page = await adapter.listPage({ cursor: null, limit: 1 })
      expect(page).toMatchObject({ schemaVersion: 1, sourceKind, observedAt: NOW })
      expect(page.records).toHaveLength(1)
      expect(page.records[0]?.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(page.operation).toBe(sourceKind === 'calendar' ? 'list_commitments'
        : sourceKind === 'contacts' ? 'list_contacts'
          : sourceKind === 'subscriptions' ? 'list_subscriptions' : 'list_options')
    }

    const calendar = new VirtualLifeSourceProvider({ sourceKind: 'calendar', clock: () => new Date(NOW),
      records: [calendarRecord('event-002'), calendarRecord('event-001')] })
    const first = await calendar.listPage({ cursor: null, limit: 1 })
    expect(first.records[0]).toMatchObject({ providerItemId: 'event-001' })
    expect(first.nextCursor).toBe('offset-1')
    expect((await calendar.listPage({ cursor: first.nextCursor, limit: 1 })).records[0])
      .toMatchObject({ providerItemId: 'event-002' })
    await expect(calendar.listPage({ cursor: null, limit: 21 })).rejects.toMatchObject({
      code: 'LIFE_PROVIDER_INPUT_INVALID', uncertain: false,
    })
    await expect(calendar.listPage({ cursor: 'raw-provider-cursor', limit: 1 })).rejects
      .toMatchObject({ code: 'LIFE_PROVIDER_INPUT_INVALID' })
  })

  it('replays identical observations and changes the digest when provider material changes', async () => {
    const adapter = provider('games')
    const first = await adapter.listPage({ cursor: null, limit: 10 })
    expect(await adapter.listPage({ cursor: null, limit: 10 })).toEqual(first)
    adapter.replaceRecords([{ ...gameRecord(), title: 'Changed puzzle title' }])
    const changed = await adapter.listPage({ cursor: null, limit: 10 })
    expect(changed.records[0]).toMatchObject({ title: 'Changed puzzle title' })
    expect(changed.records[0]?.sourceDigest).not.toBe(first.records[0]?.sourceDigest)
  })

  it('rejects source mismatches, malformed results, credentials, and invalid clocks', async () => {
    expect(() => new VirtualLifeSourceProvider({ sourceKind: 'calendar', records: [gameRecord()] }))
      .toThrow('LIFE_PROVIDER_CONFIGURATION_INVALID')
    expect(() => assertLifeProviderResult('list_contacts', {
      schemaVersion: 1, operation: 'list_options', sourceKind: 'contacts', records: [], nextCursor: null,
      observedAt: NOW,
    })).toThrow('LIFE_PROVIDER_RESPONSE_INVALID')
    expect(() => assertLifeProviderResult('cancel_subscription', {
      schemaVersion: 1, operation: 'cancel_subscription', accessToken: 'forbidden',
    })).toThrow('LIFE_SECRET_FIELD_FORBIDDEN')
    const optionPage = await provider('games').listPage({ cursor: null, limit: 1 })
    expect(() => assertLifeProviderResult('list_options', { ...optionPage,
      records: [{ ...optionPage.records[0], durationMinutes: 0 }] })).toThrow('LIFE_PROVIDER_RESPONSE_INVALID')

    const malformed = provider('contacts')
    malformed.injectFault('list_contacts', 'malformed_result')
    await expect(malformed.listPage({ cursor: null, limit: 1 })).rejects
      .toMatchObject({ code: 'LIFE_SECRET_FIELD_FORBIDDEN' })
    const badClock = new VirtualLifeSourceProvider({ sourceKind: 'contacts', records: [contactRecord()],
      clock: () => new Date(Number.NaN) })
    await expect(badClock.listPage({ cursor: null, limit: 1 })).rejects
      .toMatchObject({ code: 'LIFE_PROVIDER_CLOCK_INVALID' })
  })

  it('makes an effect-before-timeout calendar hold discoverable without duplicating it', async () => {
    const adapter = provider('calendar')
    const input = holdRequest()
    adapter.injectFault('create_calendar_hold', 'effect_before_timeout')
    await expect(adapter.createCalendarHold(input)).rejects.toMatchObject({
      code: 'LIFE_PROVIDER_RESULT_UNKNOWN', retryable: true, uncertain: true,
    })
    const lookup = await adapter.lookupCalendarHold({ providerRequestId: input.providerRequestId })
    expect(lookup).toMatchObject({ status: 'confirmed', operation: 'lookup_calendar_hold' })
    const replay = await adapter.createCalendarHold(input)
    expect(replay.providerHoldId).toBe(lookup.providerHoldId)
    expect(replay.receiptDigest).toBe(lookup.receiptDigest)
    expect(Object.keys(replay).sort()).toEqual([
      'operation', 'providerHoldId', 'providerRequestId', 'receiptDigest', 'schemaVersion', 'status',
    ])
    await expect(adapter.createCalendarHold({ ...input, optionId: 'option-substitution' })).rejects
      .toMatchObject({ code: 'LIFE_PROVIDER_REQUEST_REPLAY_MISMATCH' })
  })

  it('distinguishes timeout-before-effect and supports safe lookup then retry', async () => {
    const adapter = provider('calendar')
    const input = holdRequest()
    adapter.injectFault('create_calendar_hold', 'timeout_before_effect')
    await expect(adapter.createCalendarHold(input)).rejects.toMatchObject({
      code: 'LIFE_PROVIDER_TIMEOUT', retryable: true, uncertain: false,
    })
    expect(await adapter.lookupCalendarHold({ providerRequestId: input.providerRequestId }))
      .toMatchObject({ status: 'not_found', providerHoldId: null, receiptDigest: null })
    expect(await adapter.createCalendarHold(input)).toMatchObject({ status: 'confirmed' })
  })

  it('uses idempotent minimized calendar cancellation receipts and lookup', async () => {
    const adapter = provider('calendar')
    const hold = await adapter.createCalendarHold(holdRequest())
    const input = { providerRequestId: 'calendar-cancel-request-001', providerHoldId: hold.providerHoldId!,
      reasonCode: 'PLAN_SUPERSEDED' }
    adapter.injectFault('cancel_calendar_hold', 'effect_before_timeout')
    await expect(adapter.cancelCalendarHold(input)).rejects.toMatchObject({ uncertain: true })
    const lookup = await adapter.lookupCalendarCancellation(input)
    expect(lookup).toMatchObject({ status: 'cancelled', providerHoldId: hold.providerHoldId })
    expect((await adapter.cancelCalendarHold(input)).receiptDigest).toBe(lookup.receiptDigest)
    await expect(adapter.cancelCalendarHold({ ...input, reasonCode: 'USER_REQUEST' })).rejects
      .toMatchObject({ code: 'LIFE_PROVIDER_REQUEST_REPLAY_MISMATCH' })
  })

  it('recovers an uncertain subscription cancellation by exact request and subscription identity', async () => {
    const adapter = provider('subscriptions')
    const input = { providerRequestId: 'subscription-cancel-request-001',
      providerSubscriptionId: 'subscription-001', reasonCode: 'USER_REQUEST' }
    adapter.injectFault('cancel_subscription', 'effect_before_timeout')
    await expect(adapter.cancelSubscription(input)).rejects.toMatchObject({ uncertain: true })
    const lookup = await adapter.lookupSubscriptionCancellation(input)
    expect(lookup).toMatchObject({ status: 'cancelled', providerSubscriptionId: 'subscription-001' })
    expect(lookup.providerReceiptId).toMatch(/^vs-/)
    expect((await adapter.cancelSubscription(input)).providerReceiptId).toBe(lookup.providerReceiptId)
    await expect(adapter.lookupSubscriptionCancellation({ ...input,
      providerSubscriptionId: 'subscription-substitution' })).rejects
      .toMatchObject({ code: 'LIFE_PROVIDER_REQUEST_REPLAY_MISMATCH' })
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

function provider(sourceKind: LifeSourceKind): VirtualLifeSourceProvider {
  return new VirtualLifeSourceProvider({ sourceKind, records: recordsFor(sourceKind), clock: () => new Date(NOW) })
}

function recordsFor(sourceKind: LifeSourceKind): VirtualLifeCatalogRecord[] {
  switch (sourceKind) {
    case 'calendar': return [calendarRecord('event-001')]
    case 'contacts': return [contactRecord()]
    case 'travel': return [optionRecord('travel')]
    case 'music': return [optionRecord('music')]
    case 'games': return [gameRecord()]
    case 'subscriptions': return [subscriptionRecord()]
  }
}

function calendarRecord(providerItemId: string): VirtualLifeCatalogRecord {
  return { recordKind: 'commitment', providerItemId, label: 'Work block', category: 'work',
    startsAt: '2026-07-15T11:00:00.000Z', endsAt: '2026-07-15T12:00:00.000Z', allDay: false,
    busy: true, locationClass: 'remote', participantProviderContactIds: [], validForMinutes: 1_440 }
}

function contactRecord(): VirtualLifeCatalogRecord {
  return { recordKind: 'contact', providerContactId: 'contact-001', alias: 'Friend A',
    relationshipTags: ['friend'], availabilityTags: ['evening'] }
}

function optionRecord(kind: 'travel' | 'music'): VirtualLifeCatalogRecord {
  return { recordKind: 'option', providerItemId: `${kind}-001`, kind, source: `virtual-${kind}`,
    title: `${kind} option`, categoryTags: [kind], durationMinutes: 60, exertion: 'low',
    screenBased: kind === 'music', locationClass: kind === 'travel' ? 'local' : 'home',
    cost: { currency: 'CNY', amountMinor: kind === 'travel' ? 2_000 : 0 }, available: true,
    validForMinutes: 1_440 }
}

function gameRecord(): VirtualLifeCatalogRecord {
  return { recordKind: 'option', providerItemId: 'game-001', kind: 'game', source: 'virtual-games',
    title: 'Puzzle game', categoryTags: ['puzzle'], durationMinutes: 60, exertion: 'low',
    screenBased: true, locationClass: 'home', cost: { currency: 'CNY', amountMinor: 500 },
    available: true, validForMinutes: 1_440 }
}

function subscriptionRecord(): VirtualLifeCatalogRecord {
  return { recordKind: 'subscription', providerSubscriptionId: 'subscription-001', serviceLabel: 'Music service',
    planLabel: 'Plus', recurringCost: { currency: 'CNY', amountMinor: 1_500 },
    renewalAt: '2026-08-15T10:00:00.000Z', cancellationDeadline: '2026-08-14T10:00:00.000Z',
    state: 'active' }
}

function holdRequest() {
  return { providerRequestId: 'calendar-hold-request-001', planDigest: 'a'.repeat(64), optionId: 'option-game-001',
    window: { startsAt: '2026-07-15T11:00:00.000Z', endsAt: '2026-07-15T12:00:00.000Z' } }
}
