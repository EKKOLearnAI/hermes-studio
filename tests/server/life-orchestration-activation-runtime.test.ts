import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  getFabricControlState,
  listFabricExecutors,
  setFabricEmergencyStop,
} from '../../packages/server/src/services/hermes/action-fabric'
import { refreshEntertainmentInternetAuthorization } from '../../packages/server/src/services/hermes/internet-execution'
import { getAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'
import {
  appendLifeCheckpoint,
  configureLifeRuntimeBindings,
  createLifeCalendarHold,
  createLifeConstraintSnapshot,
  createLifePlanRevision,
  createLifeSourceAccount,
  getLifeRuntimeStatus,
  LIFE_LIVE_EXECUTOR_ID,
  LIFE_SHADOW_EXECUTOR_ID,
  LIFE_SOURCE_EXECUTOR_ID,
  listLifeActivationReviews,
  reconcileLifeRuntime,
  recordLifeOption,
  recordLifeSubscription,
  revokeLifeSourceAccount,
  stopLifeRuntime,
  transitionLifeCalendarHold,
  transitionLifeSourceAccountMode,
  updateLifeSourceAccountHealth,
  VirtualLifeSourceProvider,
  type LifeCalendarAdapter,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life orchestration activation and runtime recovery', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-runtime-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    configureLifeRuntimeBindings(null)
  })

  afterEach(() => {
    try { stopLifeRuntime() } catch { /* registry may be unavailable after a deliberate failure */ }
    configureLifeRuntimeBindings(null)
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('requires super-admin, shadow mode, recent epoch-bound evidence, and exact targets for live activation', () => {
    let account = createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'observe',
      executorId: LIFE_SOURCE_EXECUTOR_ID, displayName: 'Calendar' })
    account = updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    expect(() => transitionLifeSourceAccountMode({ accountId: account.id, toMode: 'shadow',
      actorUserId: 'admin-1', actorIsSuperAdmin: false, limits: limits(), now: NOW }))
      .toThrow('LIFE_ACTIVATION_SUPER_ADMIN_REQUIRED')
    account = transitionLifeSourceAccountMode({ accountId: account.id, toMode: 'shadow',
      actorUserId: 'admin-1', actorIsSuperAdmin: true, limits: limits(), now: NOW }).account
    expect(account).toMatchObject({ mode: 'shadow', executorId: LIFE_SHADOW_EXECUTOR_ID, policyEpoch: 2 })
    expect(() => transitionLifeSourceAccountMode({ accountId: account.id, toMode: 'live',
      actorUserId: 'admin-1', actorIsSuperAdmin: true, limits: limits(), now: LATER }))
      .toThrow('LIFE_ACTIVATION_GATE_FAILED')

    seedCalendarEvidence(account.id)
    const activated = transitionLifeSourceAccountMode({ accountId: account.id, toMode: 'live',
      actorUserId: 'admin-1', actorIsSuperAdmin: true, limits: limits(), now: LATER_2 })
    expect(activated).toMatchObject({ account: { mode: 'live', executorId: LIFE_LIVE_EXECUTOR_ID,
      policyEpoch: 3 }, review: { approved: true,
      shadowEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(listLifeActivationReviews(account.id)).toEqual([
      expect.objectContaining({ approved: true, toMode: 'live' }),
      expect.objectContaining({ approved: false, toMode: 'live' }),
      expect.objectContaining({ approved: true, toMode: 'shadow' }),
    ])
  })

  it('reconciles exact transport bindings, preserves Internet authorization, and recovers after stop', () => {
    let account = createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'shadow',
      executorId: LIFE_SHADOW_EXECUTOR_ID, displayName: 'Calendar' })
    account = updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    seedCalendarEvidence(account.id)
    const provider = calendarProvider()
    refreshEntertainmentInternetAuthorization('profile-main')
    configureLifeRuntimeBindings([{ accountId: account.id, provider, currency: 'CNY', subscriptionIds: [] }])
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 1,
      shadowExecutorEnabled: true, liveExecutorEnabled: false, emergencyStopped: false })
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: expect.arrayContaining([
        'bilibili.video.search', 'life.source.sync', 'life.calendar.hold.create',
      ]) },
      decisionAuthority: { maxRisk: 'high', allowedTargets: expect.arrayContaining([
        'internet:profile:profile-main', 'life:calendar:calendar-main',
      ]) },
    })
    refreshEntertainmentInternetAuthorization('profile-rotated')
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: expect.arrayContaining(['bilibili.video.search', 'life.source.sync']) },
      decisionAuthority: { allowedTargets: expect.arrayContaining([
        'internet:profile:profile-rotated', 'life:calendar:calendar-main',
      ]) },
    })
    stopLifeRuntime()
    expect(listFabricExecutors().find(item => item.id === LIFE_SHADOW_EXECUTOR_ID)?.enabled).toBe(false)
    expect(getAssistantRole('entertainment-assistant')?.capabilityScope.allow)
      .toEqual(expect.arrayContaining(['bilibili.video.search']))
    expect(reconcileLifeRuntime()).toMatchObject({ shadowExecutorEnabled: true, configuredAccountCount: 1 })
  })

  it('enforces circuit breaking, permanent revocation, and policy-epoch invalidation', () => {
    let account = createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'shadow',
      executorId: LIFE_SHADOW_EXECUTOR_ID, displayName: 'Calendar' })
    account = updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    configureLifeRuntimeBindings([{ accountId: account.id, provider: calendarProvider(),
      currency: 'CNY', subscriptionIds: [] }])
    expect(reconcileLifeRuntime().shadowExecutorEnabled).toBe(true)
    account = updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'unhealthy', now: LATER })
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 0, shadowExecutorEnabled: false })
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: ['twin.read'], deny: ['action.execute'] },
      decisionAuthority: { maxRisk: 'none', requireApprovalAbove: 'none', allowedTargets: [] },
    })
    const revoked = revokeLifeSourceAccount({ accountId: account.id, actorUserId: 'admin-1',
      actorIsSuperAdmin: true, expectedVersion: account.version, now: LATER_2 })
    expect(revoked).toMatchObject({ health: 'revoked', enabled: false, policyEpoch: 2 })
    expect(() => updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: revoked.version,
      health: 'healthy', now: LATER_2 })).toThrow('LIFE_ACCOUNT_REVOKED')
  })

  it('requires exact subscription identities before authorizing cancellation', () => {
    const account = createLifeSourceAccount({ id: 'subscriptions-main', sourceKind: 'subscriptions', mode: 'shadow',
      executorId: LIFE_SHADOW_EXECUTOR_ID, displayName: 'Subscriptions' })
    const subscription = recordLifeSubscription({ accountId: account.id,
      providerSubscriptionId: 'provider-subscription-001', serviceLabel: 'Music', planLabel: 'Plus',
      recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: TOMORROW,
      cancellationDeadline: null, state: 'active', observedAt: NOW, sourceDigest: '2'.repeat(64) })
    const provider = new VirtualLifeSourceProvider({ sourceKind: 'subscriptions', clock: () => new Date(NOW),
      records: [{ recordKind: 'subscription', providerSubscriptionId: 'provider-subscription-001',
        serviceLabel: 'Music', planLabel: 'Plus', recurringCost: { currency: 'CNY', amountMinor: 1_500 },
        renewalAt: TOMORROW, cancellationDeadline: null, state: 'active' }] })
    configureLifeRuntimeBindings([{ accountId: account.id, provider, currency: 'CNY',
      subscriptionIds: ['subscription-not-owned'] }])
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 0, shadowExecutorEnabled: false })
    configureLifeRuntimeBindings([{ accountId: account.id, provider, currency: 'CNY',
      subscriptionIds: [subscription.id] }])
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 1, shadowExecutorEnabled: true })
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: expect.arrayContaining(['life.subscription.cancel']) },
      decisionAuthority: { allowedTargets: expect.arrayContaining([`life:subscription:${subscription.id}`]) },
    })
  })

  it('enables only exact live transport and disables it under emergency stop', () => {
    let account = createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'shadow',
      executorId: LIFE_SHADOW_EXECUTOR_ID, displayName: 'Calendar' })
    account = updateLifeSourceAccountHealth({ accountId: account.id, expectedVersion: account.version,
      health: 'healthy', now: NOW })
    seedCalendarEvidence(account.id)
    account = transitionLifeSourceAccountMode({ accountId: account.id, toMode: 'live',
      actorUserId: 'admin-1', actorIsSuperAdmin: true, limits: limits(), now: LATER }).account
    const external = externalView(calendarProvider())
    configureLifeRuntimeBindings([{ accountId: account.id, provider: external,
      currency: 'CNY', subscriptionIds: [] }])
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 1,
      liveExecutorEnabled: true, emergencyStopped: false })
    expect(listFabricExecutors().find(item => item.id === LIFE_LIVE_EXECUTOR_ID)?.enabled).toBe(true)
    const control = getFabricControlState()
    setFabricEmergencyStop(3, 'admin-1', 'life emergency', control.version)
    expect(reconcileLifeRuntime()).toMatchObject({ liveExecutorEnabled: false, emergencyStopped: true })
    expect(getLifeRuntimeStatus().authorizedTargetCount).toBe(0)
  })
})

const NOW = '2026-07-15T10:00:00.000Z'
const LATER = '2026-07-15T11:00:00.000Z'
const LATER_2 = '2026-07-15T11:01:00.000Z'
const SESSION_START = '2026-07-15T12:00:00.000Z'
const SESSION_END = '2026-07-15T13:00:00.000Z'
const TOMORROW = '2026-07-16T10:00:00.000Z'

function limits() { return { currency: 'CNY', calendarIds: ['calendar-main'], subscriptionIds: [] } }

function seedCalendarEvidence(accountId: string): void {
  const option = recordLifeOption({ accountId: null, kind: 'video', source: 'bilibili',
    providerItemId: `video-${accountId}`, title: 'Documentary', categoryTags: ['documentary'], durationMinutes: 60,
    exertion: 'low', screenBased: true, locationClass: 'home', cost: null, available: true,
    observedAt: NOW, expiresAt: TOMORROW, sourceDigest: '1'.repeat(64) })
  const constraint = createLifeConstraintSnapshot({ subjectId: 'person:self',
    horizon: { startsAt: SESSION_START, endsAt: '2026-07-15T14:00:00.000Z' }, timezone: 'Asia/Shanghai',
    freeWindows: [{ startsAt: SESSION_START, endsAt: '2026-07-15T14:00:00.000Z' }], commitmentIds: [],
    readiness: 'normal', recovery: 'good', sleepDebt: 'none', screenTimeUsedMinutes: 0,
    screenTimeLimitMinutes: 180, leisureTimeLimitMinutes: 120, budget: { currency: 'CNY', amountMinor: 0 },
    quietStartMinute: 1_380, quietEndMinute: 420, maxTravelRadiusKm: 0, excludedCategories: [],
    preferredCategories: ['documentary'], factRefs: [], createdAt: NOW, expiresAt: TOMORROW })
  const plan = createLifePlanRevision({ constraintSnapshotId: constraint.id,
    candidates: [{ optionId: option.id, eligible: true, score: 100, exclusionCodes: [], rationaleCodes: [] }],
    sessions: [{ optionId: option.id, startsAt: SESSION_START, endsAt: SESSION_END,
      cost: null, rationaleCodes: [] }], createdAt: NOW })
  let hold = createLifeCalendarHold({ workflowId: `workflow-evidence-${accountId}`,
    intentId: `intent-evidence-${accountId}`, accountId, planRevisionId: plan.id, optionId: option.id,
    window: { startsAt: SESSION_START, endsAt: SESSION_END },
    providerRequestId: `request-evidence-${accountId}`, createdAt: NOW })
  hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
    state: 'submitting', updatedAt: NOW })
  hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
    state: 'confirmed', providerHoldId: `provider-hold-${accountId}`, receiptDigest: 'a'.repeat(64),
    completedAt: '2026-07-15T10:05:00.000Z', updatedAt: '2026-07-15T10:05:00.000Z' })
  appendLifeCheckpoint({ aggregateKind: 'calendar_hold', aggregateId: hold.id, stage: 'provider_confirmed',
    evidenceDigest: 'a'.repeat(64), details: { providerState: 'confirmed' },
    observedAt: '2026-07-15T10:05:00.000Z' })
}

function calendarProvider(): VirtualLifeSourceProvider {
  return new VirtualLifeSourceProvider({ sourceKind: 'calendar', records: [], clock: () => new Date(NOW) })
}

function externalView(provider: VirtualLifeSourceProvider): LifeCalendarAdapter {
  return new Proxy(provider, { get(target, property) {
    if (property === 'transport') return 'external'
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as LifeCalendarAdapter
}
