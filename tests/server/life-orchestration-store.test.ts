import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendLifeCheckpoint,
  createLifeCalendarHold,
  createLifeConstraintSnapshot,
  createLifeHandoff,
  createLifePlanRevision,
  createLifeSourceAccount,
  createLifeSubscriptionCancellation,
  lifeCanonicalDigest,
  listLifeCheckpoints,
  recordLifeCommitment,
  recordLifeContactAlias,
  recordLifeOption,
  recordLifeSubscription,
  transitionLifeCalendarHold,
  transitionLifeHandoff,
  transitionLifePlanRevision,
  transitionLifeSubscriptionCancellation,
  updateLifeSourceAccount,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life orchestration durable store', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-store-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('canonicalizes digests and enforces account replay, CAS, live activation, and permanent revocation', () => {
    expect(lifeCanonicalDigest({ b: [2, 1], a: true })).toBe(lifeCanonicalDigest({ a: true, b: [2, 1] }))
    const account = accountInput('calendar-main', 'calendar')
    expect(createLifeSourceAccount(account)).toMatchObject({ version: 1, health: 'unknown', policyEpoch: 1 })
    expect(createLifeSourceAccount(account).id).toBe('calendar-main')
    expect(() => createLifeSourceAccount({ ...account, displayName: 'Other calendar' }))
      .toThrow('LIFE_ACCOUNT_REPLAY_MISMATCH')
    expect(() => createLifeSourceAccount({ ...account, id: 'calendar-live', mode: 'live' }))
      .toThrow('LIFE_ACCOUNT_INPUT_INVALID')

    const healthy = updateLifeSourceAccount({ accountId: account.id, expectedVersion: 1, health: 'healthy', updatedAt: T1 })
    expect(healthy).toMatchObject({ version: 2, policyEpoch: 1, health: 'healthy' })
    expect(() => updateLifeSourceAccount({ accountId: account.id, expectedVersion: 1, enabled: false, updatedAt: T2 }))
      .toThrow('LIFE_ACCOUNT_VERSION_CONFLICT')
    expect(() => updateLifeSourceAccount({ accountId: account.id, expectedVersion: 2, mode: 'live', updatedAt: T2 }))
      .toThrow('LIFE_LIVE_ACTIVATION_REQUIRED')
    const revoked = updateLifeSourceAccount({ accountId: account.id, expectedVersion: 2, revoke: true, updatedAt: T2 })
    expect(revoked).toMatchObject({ version: 3, policyEpoch: 2, health: 'revoked', enabled: false, revokedAt: T2 })
    expect(() => updateLifeSourceAccount({ accountId: account.id, expectedVersion: 3, health: 'healthy', updatedAt: T3 }))
      .toThrow('LIFE_ACCOUNT_REVOKED')
  })

  it('content-addresses immutable contacts, commitments, options, and mutable subscription observations', () => {
    seedAccounts()
    const contact = recordLifeContactAlias(contactInput())
    expect(recordLifeContactAlias(contactInput())).toEqual(contact)
    const commitmentInput = commitmentObservation(contact.id)
    const commitment = recordLifeCommitment(commitmentInput)
    expect(recordLifeCommitment(commitmentInput)).toEqual(commitment)
    expect(() => recordLifeCommitment({ ...commitmentInput, label: 'Substituted event' }))
      .toThrow('LIFE_COMMITMENT_REPLAY_MISMATCH')

    const game = recordLifeOption(gameObservation())
    expect(recordLifeOption(gameObservation())).toEqual(game)
    expect(recordLifeOption(videoObservation())).toMatchObject({ accountId: null, kind: 'video', source: 'bilibili' })
    expect(() => recordLifeOption({ ...gameObservation(), accountId: null }))
      .toThrow('LIFE_OPTION_ACCOUNT_MISMATCH')

    const subscription = recordLifeSubscription(subscriptionObservation())
    expect(recordLifeSubscription(subscriptionObservation())).toEqual(subscription)
    const cancelled = recordLifeSubscription({
      ...subscriptionObservation(), state: 'cancelled', sourceDigest: D6, observedAt: T2,
    })
    expect(cancelled).toMatchObject({ id: subscription.id, state: 'cancelled', version: 2, sourceDigest: D6 })
    expect(() => recordLifeSubscription({
      ...subscriptionObservation(), state: 'active', sourceDigest: D7, observedAt: T3,
    })).toThrow(/subscription state transition/i)
  })

  it('freezes constraint and plan material and allows only monotonic CAS plan transitions', () => {
    const { constraint, game, plan } = seedPlan()
    expect(createLifeConstraintSnapshot(constraintInput()).id).toBe(constraint.id)
    expect(createLifePlanRevision(planInput(constraint.id, game.id)).id).toBe(plan.id)
    expect(plan).toMatchObject({ totalMinutes: 60, totalCost: { currency: 'CNY', amountMinor: 500 }, state: 'proposed' })
    expect(() => createLifePlanRevision({
      ...planInput(constraint.id, game.id),
      sessions: [{ ...planInput(constraint.id, game.id).sessions[0]!, cost: { currency: 'CNY', amountMinor: 501 } }],
    })).toThrow('LIFE_PLAN_SESSION_MATERIAL_MISMATCH')

    const reserved = transitionLifePlanRevision({ planId: plan.id, expectedVersion: 1, state: 'reserved', updatedAt: T2 })
    expect(reserved).toMatchObject({ state: 'reserved', version: 2 })
    expect(() => transitionLifePlanRevision({ planId: plan.id, expectedVersion: 1, state: 'completed', updatedAt: T3 }))
      .toThrow('LIFE_PLAN_VERSION_CONFLICT')
    expect(transitionLifePlanRevision({ planId: plan.id, expectedVersion: 2, state: 'completed', updatedAt: T3 }))
      .toMatchObject({ state: 'completed', version: 3 })
  })

  it('binds calendar holds to frozen plans and protects provider identity and checkpoint evidence', () => {
    const { game, plan } = seedPlan()
    const input = {
      workflowId: 'workflow-calendar-hold-001', intentId: 'intent-calendar-hold-001', accountId: 'calendar-main',
      planRevisionId: plan.id, optionId: game.id, window: { startsAt: T4, endsAt: T5 },
      providerRequestId: 'request-calendar-hold-001', createdAt: T0,
    }
    const hold = createLifeCalendarHold(input)
    expect(createLifeCalendarHold(input)).toEqual(hold)
    expect(() => createLifeCalendarHold({ ...input, providerRequestId: 'request-calendar-hold-002' }))
      .toThrow('LIFE_CALENDAR_HOLD_REPLAY_MISMATCH')
    const submitting = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: 1, state: 'submitting', updatedAt: T1 })
    const confirmed = transitionLifeCalendarHold({
      holdId: hold.id, expectedVersion: submitting.version, state: 'confirmed', providerHoldId: 'provider-hold-001',
      receiptDigest: D8, completedAt: T2, updatedAt: T2,
    })
    expect(confirmed).toMatchObject({ state: 'confirmed', providerHoldId: 'provider-hold-001', receiptDigest: D8 })
    expect(() => transitionLifeCalendarHold({
      holdId: hold.id, expectedVersion: confirmed.version, state: 'cancel_requested',
      providerHoldId: 'provider-hold-substitute', updatedAt: T3,
    })).toThrow('LIFE_PROVIDER_HOLD_ID_SUBSTITUTION')

    const checkpoint = appendLifeCheckpoint({ aggregateKind: 'calendar_hold', aggregateId: hold.id,
      stage: 'provider_confirmed', evidenceDigest: D8, details: { providerState: 'confirmed' }, observedAt: T2 })
    expect(appendLifeCheckpoint({ aggregateKind: 'calendar_hold', aggregateId: hold.id,
      stage: 'provider_confirmed', evidenceDigest: D8, details: { providerState: 'confirmed' }, observedAt: T3 })).toEqual(checkpoint)
    expect(listLifeCheckpoints('calendar_hold', hold.id)).toHaveLength(1)
    expect(() => appendLifeCheckpoint({ aggregateKind: 'calendar_hold', aggregateId: hold.id,
      stage: 'unsafe_payload', details: { accessToken: 'secret-value' }, observedAt: T3 }))
      .toThrow('LIFE_SECRET_FIELD_FORBIDDEN')
  })

  it('persists exact subscription cancellations and typed downstream handoffs', () => {
    const { game, plan } = seedPlan()
    const subscription = recordLifeSubscription(subscriptionObservation())
    const cancellationInput = {
      workflowId: 'workflow-subscription-cancel-001', intentId: 'intent-subscription-cancel-001',
      accountId: 'subscriptions-main', subscriptionId: subscription.id,
      providerRequestId: 'request-subscription-cancel-001', reasonCode: 'USER_REQUEST', createdAt: T0,
    }
    const cancellation = createLifeSubscriptionCancellation(cancellationInput)
    expect(createLifeSubscriptionCancellation(cancellationInput)).toEqual(cancellation)
    const submitting = transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
      expectedVersion: 1, state: 'submitting', updatedAt: T1 })
    const processing = transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
      expectedVersion: submitting.version, state: 'processing', providerReceiptId: 'provider-receipt-001',
      receiptDigest: D9, updatedAt: T2 })
    expect(() => transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
      expectedVersion: processing.version, state: 'cancelled', providerReceiptId: 'provider-receipt-substitute',
      receiptDigest: D9, completedAt: T3, updatedAt: T3 })).toThrow('LIFE_RECEIPT_SUBSTITUTION')
    expect(transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
      expectedVersion: processing.version, state: 'cancelled', completedAt: T3, updatedAt: T3 }))
      .toMatchObject({ state: 'cancelled', version: 4, providerReceiptId: 'provider-receipt-001' })

    const handoff = createLifeHandoff({ planRevisionId: plan.id, optionId: game.id, kind: 'android',
      targetCapabilityId: 'android.app.execute', createdAt: T0 })
    expect(createLifeHandoff({ planRevisionId: plan.id, optionId: game.id, kind: 'android',
      targetCapabilityId: 'android.app.execute', createdAt: T1 })).toEqual(handoff)
    expect(() => createLifeHandoff({ planRevisionId: plan.id, optionId: game.id, kind: 'internet',
      targetCapabilityId: 'android.app.execute', createdAt: T1 })).toThrow('LIFE_HANDOFF_TARGET_INVALID')
    expect(transitionLifeHandoff({ handoffId: handoff.id, expectedVersion: 1, state: 'accepted', updatedAt: T1 }))
      .toMatchObject({ state: 'accepted', version: 2 })
  })
})

const T0 = '2026-07-15T08:00:00.000Z'
const T1 = '2026-07-15T09:00:00.000Z'
const T2 = '2026-07-15T09:15:00.000Z'
const T3 = '2026-07-15T09:30:00.000Z'
const T4 = '2026-07-15T10:00:00.000Z'
const T5 = '2026-07-15T11:00:00.000Z'
const T6 = '2026-07-15T12:00:00.000Z'
const T7 = '2026-07-16T08:00:00.000Z'
const D1 = '1'.repeat(64)
const D2 = '2'.repeat(64)
const D3 = '3'.repeat(64)
const D4 = '4'.repeat(64)
const D5 = '5'.repeat(64)
const D6 = '6'.repeat(64)
const D7 = '7'.repeat(64)
const D8 = '8'.repeat(64)
const D9 = '9'.repeat(64)

function accountInput(id: string, sourceKind: 'calendar' | 'contacts' | 'travel' | 'music' | 'games' | 'subscriptions') {
  return { id, sourceKind, mode: 'shadow' as const, executorId: `executor-${sourceKind}`, displayName: `${sourceKind} main` }
}

function seedAccounts(): void {
  createLifeSourceAccount(accountInput('calendar-main', 'calendar'))
  createLifeSourceAccount(accountInput('contacts-main', 'contacts'))
  createLifeSourceAccount(accountInput('games-main', 'games'))
  createLifeSourceAccount(accountInput('subscriptions-main', 'subscriptions'))
}

function contactInput() {
  return { accountId: 'contacts-main', providerContactId: 'provider-contact-001', alias: 'Friend A',
    relationshipTags: ['friend'], availabilityTags: ['evening'], observedAt: T0, sourceDigest: D1 }
}

function commitmentObservation(contactId: string) {
  return { accountId: 'calendar-main', providerItemId: 'provider-event-001', label: 'Work block',
    category: 'work' as const, startsAt: T1, endsAt: T2, allDay: false, busy: true,
    locationClass: 'remote' as const, participantAliasIds: [contactId], observedAt: T0, expiresAt: T7,
    sourceDigest: D2 }
}

function gameObservation() {
  return { accountId: 'games-main', kind: 'game' as const, source: 'virtual-games',
    providerItemId: 'provider-game-001', title: 'Puzzle session', categoryTags: ['puzzle'], durationMinutes: 60,
    exertion: 'low' as const, screenBased: true, locationClass: 'home' as const,
    cost: { currency: 'CNY', amountMinor: 500 }, available: true, observedAt: T0, expiresAt: T7,
    sourceDigest: D3 }
}

function videoObservation() {
  return { accountId: null, kind: 'video' as const, source: 'bilibili', providerItemId: 'bvid-BV1234567890',
    title: 'Documentary', categoryTags: ['documentary'], durationMinutes: 45, exertion: 'low' as const,
    screenBased: true, locationClass: 'home' as const, cost: null, available: true,
    observedAt: T0, expiresAt: T7, sourceDigest: D4 }
}

function subscriptionObservation() {
  return { accountId: 'subscriptions-main', providerSubscriptionId: 'provider-subscription-001',
    serviceLabel: 'Music service', planLabel: 'Plus plan', recurringCost: { currency: 'CNY', amountMinor: 1_500 },
    renewalAt: T7, cancellationDeadline: T6, state: 'active' as const, observedAt: T0, sourceDigest: D5 }
}

function constraintInput() {
  return { subjectId: 'person:self', horizon: { startsAt: T4, endsAt: T6 }, timezone: 'Asia/Shanghai',
    freeWindows: [{ startsAt: T4, endsAt: T6 }], commitmentIds: [], readiness: 'normal' as const,
    recovery: 'good' as const, sleepDebt: 'none' as const, screenTimeUsedMinutes: 30,
    screenTimeLimitMinutes: 180, leisureTimeLimitMinutes: 120, budget: { currency: 'CNY', amountMinor: 2_000 },
    quietStartMinute: 1_380, quietEndMinute: 420, maxTravelRadiusKm: 20, excludedCategories: [],
    preferredCategories: ['puzzle'], factRefs: [], createdAt: T0, expiresAt: T7 }
}

function planInput(constraintSnapshotId: string, optionId: string) {
  return { constraintSnapshotId, candidates: [{ optionId, eligible: true, score: 100,
    exclusionCodes: [], rationaleCodes: ['PREFERENCE_MATCH'] }], sessions: [{ optionId, startsAt: T4, endsAt: T5,
    cost: { currency: 'CNY', amountMinor: 500 }, rationaleCodes: ['PREFERENCE_MATCH'] }], createdAt: T0 }
}

function seedPlan() {
  seedAccounts()
  const game = recordLifeOption(gameObservation())
  const constraint = createLifeConstraintSnapshot(constraintInput())
  const plan = createLifePlanRevision(planInput(constraint.id, game.id))
  return { constraint, game, plan }
}
