import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindFabricExecutorCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  getFabricCapability,
  invokeFabricExecutor,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  updateFabricExecutorHealth,
  type FabricExecutionContext,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  createLifeConstraintSnapshot,
  createLifeExecutorAdapter,
  createLifePlanRevision,
  createLifeSourceAccount,
  createLifeSubscriptionCancellation,
  getLifeCalendarHold,
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CAPABILITY_IDS,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
  lifeSubscriptionMaterialDigest,
  recordLifeOption,
  recordLifeSubscription,
  transitionLifePlanRevision,
  VirtualLifeSourceProvider,
  type LifeCalendarAdapter,
  type LifePlanRevision,
  type LifeSourceAdapter,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life orchestration Action Fabric executor', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''
  let calendar: VirtualLifeSourceProvider
  let games: VirtualLifeSourceProvider
  let subscriptions: VirtualLifeSourceProvider
  let providers: Map<string, LifeSourceAdapter>
  let plan: LifePlanRevision
  let optionId = ''
  let subscriptionId = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-executor-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    createFabricExecutor({ id: EXECUTOR, type: 'connector', name: 'Life shadow test', environment: 'sandbox',
      configuration: { externalWrite: false, shadow: true, interruptible: true }, enabled: true })
    for (const capabilityId of LIFE_CAPABILITY_IDS) {
      const capability = getFabricCapability(capabilityId)!
      bindFabricExecutorCapability(EXECUTOR, capability.id, capability.version, capability.contractDigest)
    }
    updateFabricExecutorHealth(EXECUTOR, 'healthy', {})
    for (const [id, sourceKind] of [['calendar-main', 'calendar'], ['games-main', 'games'],
      ['subscriptions-main', 'subscriptions']] as const) {
      createLifeSourceAccount({ id, sourceKind, mode: 'shadow', executorId: EXECUTOR,
        displayName: `${sourceKind} shadow` })
    }
    calendar = new VirtualLifeSourceProvider({ sourceKind: 'calendar', records: [], clock: () => new Date(NOW) })
    games = new VirtualLifeSourceProvider({ sourceKind: 'games', clock: () => new Date(NOW), records: [
      gameProviderRecord('sync-game-001'), gameProviderRecord('sync-game-002'),
    ] })
    subscriptions = new VirtualLifeSourceProvider({ sourceKind: 'subscriptions', clock: () => new Date(NOW),
      records: [subscriptionProviderRecord()] })
    providers = new Map([['calendar-main', calendar], ['games-main', games],
      ['subscriptions-main', subscriptions]])
    registerFabricExecutorAdapter(createLifeExecutorAdapter({ id: EXECUTOR,
      providerForAccount: accountId => providers.get(accountId) ?? null }))
    const seeded = seedPlan()
    plan = seeded.plan
    optionId = seeded.optionId
    const subscription = recordLifeSubscription({ accountId: 'subscriptions-main',
      providerSubscriptionId: 'provider-subscription-001', serviceLabel: 'Music service', planLabel: 'Plus',
      recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: TOMORROW,
      cancellationDeadline: '2026-07-16T09:00:00.000Z', state: 'active', observedAt: NOW,
      sourceDigest: '2'.repeat(64) })
    subscriptionId = subscription.id
  })

  afterEach(() => {
    unregisterFabricExecutorAdapter(EXECUTOR)
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('projects one bounded source page, replays it, and verifies persisted identities', async () => {
    const context = executionContext(LIFE_SOURCE_SYNC_CAPABILITY,
      { schemaVersion: 1, accountId: 'games-main', sourceKind: 'games', cursor: null, limit: 1 },
      { kind: 'life_source', accountId: 'games-main', sourceKind: 'games' }, 'source')
    const prepared = await invokeFabricExecutor('prepare', context)
    expect(prepared).toMatchObject({ outcome: 'prepared', output: { accountId: 'games-main', mode: 'shadow',
      policyEpoch: 1, materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    const executing = { ...context, preparedOutput: prepared.output }
    const first = await invokeFabricExecutor('execute', executing)
    expect(first).toMatchObject({ outcome: 'succeeded', output: { operation: 'source_sync', sourceKind: 'games',
      status: 'partial', totalCount: 1, nextCursor: 'offset-1',
      recordIds: [expect.stringMatching(/^option-/)] } })
    expect((await invokeFabricExecutor('execute', executing)).output).toEqual(first.output)
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: first.output }))
      .resolves.toMatchObject({ outcome: 'verified', output: first.output })
    await expect(invokeFabricExecutor('execute', { ...executing,
      preparedOutput: { ...prepared.output, materialDigest: '0'.repeat(64) } })).resolves.toMatchObject({
      outcome: 'permanent_failure', errorCode: 'LIFE_PREPARATION_INVALID',
    })
  })

  it('verifies an immutable plan and rejects target substitution before execution', async () => {
    const input = planInput()
    const context = executionContext(LIFE_PLAN_VERIFY_CAPABILITY, input,
      { kind: 'life_plan', planDigest: plan.planDigest, currency: 'CNY' }, 'plan')
    const prepared = await invokeFabricExecutor('prepare', context)
    const executing = { ...context, preparedOutput: prepared.output }
    const result = await invokeFabricExecutor('execute', executing)
    expect(result).toMatchObject({ outcome: 'succeeded', output: { operation: 'plan_verify',
      planRevisionId: plan.id, planDigest: plan.planDigest, valid: true, reasonCodes: [], checkedAt: NOW } })
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: result.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    const forged = executionContext(LIFE_PLAN_VERIFY_CAPABILITY, input,
      { kind: 'life_plan', planDigest: 'f'.repeat(64), currency: 'CNY' }, 'forged-plan')
    await expect(invokeFabricExecutor('prepare', forged)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'LIFE_EXECUTOR_CONTEXT_INVALID',
    })
    const wrongWindow = calendarCreateContext('wrong-window')
    wrongWindow.input = { ...wrongWindow.input, endsAt: '2026-07-15T12:01:00.000Z' }
    await expect(invokeFabricExecutor('prepare', wrongWindow)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'LIFE_PLAN_SESSION_MATERIAL_MISMATCH',
    })
  })

  it('creates, verifies, replays, and semantically cancels an exact calendar hold', async () => {
    const created = await createHold('calendar')
    const executing = created.executing
    expect(created.result).toMatchObject({ outcome: 'succeeded', output: { operation: 'calendar_hold_create',
      state: 'confirmed', optionId, providerHoldId: expect.stringMatching(/^vh-/),
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect((await invokeFabricExecutor('execute', executing)).output).toEqual(created.result.output)
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: created.result.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: {
      ...created.result.output, receiptDigest: 'f'.repeat(64),
    } })).resolves.toMatchObject({ outcome: 'mismatch', errorCode: 'LIFE_VERIFICATION_MISMATCH' })
    expect(created.result.evidence).toEqual([expect.objectContaining({ kind: 'life_receipt', data: {
      capabilityId: LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
      materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), holdId: expect.any(String),
    } })])
    expect(JSON.stringify(created.result.evidence)).not.toMatch(/provider(?:Hold|Request|Receipt)Id/)

    const reused = { ...calendarCreateContext('calendar'), intentId: 'intent-calendar-owner-conflict',
      workflowId: 'workflow-calendar-owner-conflict', stepId: 'step-calendar-owner-conflict',
      executionToken: 'execution-calendar-owner-conflict' }
    const reusedPrepared = await invokeFabricExecutor('prepare', reused)
    await expect(invokeFabricExecutor('execute', { ...reused, preparedOutput: reusedPrepared.output }))
      .resolves.toMatchObject({ outcome: 'permanent_failure',
        errorCode: 'LIFE_PROVIDER_REQUEST_OWNED_BY_OTHER_WORKFLOW' })

    const hold = getLifeCalendarHold(String(created.result.output.holdId))!
    const input = { schemaVersion: 1, accountId: 'calendar-main', planRevisionId: plan.id,
      planDigest: plan.planDigest, providerRequestId: 'request-calendar-cancel-001', currency: 'CNY',
      holdId: hold.id, expectedVersion: hold.version, providerHoldId: hold.providerHoldId!,
      reasonCode: 'USER_REQUEST' }
    const cancel = executionContext(LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY, input, calendarTarget(), 'calendar-cancel')
    const prepared = await invokeFabricExecutor('prepare', cancel)
    const cancelExecuting = { ...cancel, preparedOutput: prepared.output }
    const result = await invokeFabricExecutor('execute', cancelExecuting)
    expect(result).toMatchObject({ outcome: 'succeeded', output: { operation: 'calendar_hold_cancel',
      holdId: hold.id, state: 'cancelled', providerHoldId: hold.providerHoldId,
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    await expect(invokeFabricExecutor('verify', { ...cancelExecuting, executionOutput: result.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
  })

  it('recovers effect-before-timeout by provider lookup and can compensate a confirmed hold', async () => {
    calendar.injectFault('create_calendar_hold', 'timeout_before_effect')
    const retryContext = calendarCreateContext('safe-retry')
    const retryPrepared = await invokeFabricExecutor('prepare', retryContext)
    const retryExecuting = { ...retryContext, preparedOutput: retryPrepared.output }
    await expect(invokeFabricExecutor('execute', retryExecuting)).resolves.toMatchObject({
      outcome: 'temporary_failure', errorCode: 'LIFE_PROVIDER_TIMEOUT', safeToRetry: true,
    })
    await expect(invokeFabricExecutor('execute', retryExecuting)).resolves.toMatchObject({
      outcome: 'succeeded', output: { state: 'confirmed' }, safeToRetry: false,
    })

    calendar.injectFault('create_calendar_hold', 'effect_before_timeout')
    const context = calendarCreateContext('uncertain')
    const prepared = await invokeFabricExecutor('prepare', context)
    const executing = { ...context, preparedOutput: prepared.output }
    await expect(invokeFabricExecutor('execute', executing)).resolves.toMatchObject({
      outcome: 'unknown', errorCode: 'LIFE_PROVIDER_RESULT_UNKNOWN', safeToRetry: false,
    })
    transitionLifePlanRevision({ planId: plan.id, expectedVersion: plan.version, state: 'superseded',
      updatedAt: '2026-07-15T10:01:00.000Z' })
    await expect(invokeFabricExecutor('prepare', calendarCreateContext('fresh-stale'))).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'LIFE_PLAN_STALE',
    })
    const recovered = await invokeFabricExecutor('execute', executing)
    expect(recovered).toMatchObject({ outcome: 'succeeded', output: { state: 'confirmed' } })
    const compensated = await invokeFabricExecutor('compensate', { ...executing, executionOutput: recovered.output })
    expect(compensated).toMatchObject({ outcome: 'compensated', output: { state: 'cancelled',
      holdId: recovered.output.holdId, receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
  })

  it('cancels an exact subscription with durable receipt identity and blocks observe-mode writes', async () => {
    const subscription = recordLifeSubscription({ accountId: 'subscriptions-main',
      providerSubscriptionId: 'provider-subscription-001', serviceLabel: 'Music service', planLabel: 'Plus',
      recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: TOMORROW,
      cancellationDeadline: '2026-07-16T09:00:00.000Z', state: 'active', observedAt: NOW,
      sourceDigest: '2'.repeat(64) })
    const input = { schemaVersion: 1, accountId: 'subscriptions-main', subscriptionId,
      subscriptionDigest: lifeSubscriptionMaterialDigest(subscription),
      providerRequestId: 'request-subscription-cancel-001', reasonCode: 'USER_REQUEST', currency: 'CNY' }
    const context = executionContext(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, input,
      { kind: 'life_subscription', accountId: 'subscriptions-main', subscriptionId, currency: 'CNY' }, 'subscription')
    const prepared = await invokeFabricExecutor('prepare', context)
    const executing = { ...context, preparedOutput: prepared.output }
    subscriptions.injectFault('cancel_subscription', 'effect_before_timeout')
    await expect(invokeFabricExecutor('execute', executing)).resolves.toMatchObject({
      outcome: 'unknown', errorCode: 'LIFE_PROVIDER_RESULT_UNKNOWN', safeToRetry: false,
    })
    expect(() => createLifeSubscriptionCancellation({ workflowId: 'workflow-subscription-other',
      intentId: 'intent-subscription-other', accountId: 'subscriptions-main', subscriptionId,
      providerRequestId: input.providerRequestId, reasonCode: input.reasonCode, createdAt: NOW }))
      .toThrow('LIFE_PROVIDER_REQUEST_OWNED_BY_OTHER_WORKFLOW')
    recordLifeSubscription({ accountId: 'subscriptions-main',
      providerSubscriptionId: 'provider-subscription-001', serviceLabel: 'Music service', planLabel: 'Plus',
      recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: TOMORROW,
      cancellationDeadline: '2026-07-16T09:00:00.000Z', state: 'cancelled',
      observedAt: '2026-07-15T10:01:00.000Z', sourceDigest: '3'.repeat(64) })
    const result = await invokeFabricExecutor('execute', executing)
    expect(result).toMatchObject({ outcome: 'succeeded', output: { operation: 'subscription_cancel',
      subscriptionId, state: 'cancelled', providerReceiptId: expect.stringMatching(/^vs-/),
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect((await invokeFabricExecutor('execute', executing)).output).toEqual(result.output)
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: result.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    expect(result.evidence).toEqual([expect.objectContaining({ kind: 'life_receipt', data: {
      capabilityId: LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
      materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), cancellationId: expect.any(String),
    } })])
    expect(JSON.stringify(result.evidence)).not.toMatch(/provider(?:Hold|Request|Receipt)Id/)

    createLifeSourceAccount({ id: 'subscriptions-other', sourceKind: 'subscriptions', mode: 'shadow',
      executorId: EXECUTOR, displayName: 'Other subscriptions shadow' })
    providers.set('subscriptions-other', subscriptions)
    const crossAccountInput = { ...input, accountId: 'subscriptions-other' }
    const crossAccount = executionContext(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, crossAccountInput,
      { kind: 'life_subscription', accountId: 'subscriptions-other', subscriptionId, currency: 'CNY' },
      'cross-account')
    await expect(invokeFabricExecutor('prepare', crossAccount)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'LIFE_SUBSCRIPTION_MATERIAL_MISMATCH',
    })

    createLifeSourceAccount({ id: 'subscriptions-observe', sourceKind: 'subscriptions', mode: 'observe',
      executorId: EXECUTOR, displayName: 'Subscriptions observe' })
    providers.set('subscriptions-observe', subscriptions)
    const blockedInput = { ...input, accountId: 'subscriptions-observe' }
    const blocked = executionContext(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, blockedInput,
      { kind: 'life_subscription', accountId: 'subscriptions-observe', subscriptionId, currency: 'CNY' }, 'blocked')
    await expect(invokeFabricExecutor('prepare', blocked)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'LIFE_ACCOUNT_UNAVAILABLE',
    })

    const externalCalendar: LifeCalendarAdapter = {
      sourceKind: 'calendar', transport: 'external',
      listPage: input => calendar.listPage(input),
      createCalendarHold: input => calendar.createCalendarHold(input),
      lookupCalendarHold: input => calendar.lookupCalendarHold(input),
      cancelCalendarHold: input => calendar.cancelCalendarHold(input),
      lookupCalendarCancellation: input => calendar.lookupCalendarCancellation(input),
    }
    providers.set('calendar-main', externalCalendar)
    await expect(invokeFabricExecutor('prepare', calendarCreateContext('transport-mismatch')))
      .resolves.toMatchObject({ outcome: 'failed', errorCode: 'LIFE_PROVIDER_UNAVAILABLE' })
  })

  async function createHold(suffix: string) {
    const context = calendarCreateContext(suffix)
    const prepared = await invokeFabricExecutor('prepare', context)
    const executing = { ...context, preparedOutput: prepared.output }
    return { executing, result: await invokeFabricExecutor('execute', executing) }
  }

  function calendarCreateContext(suffix: string) {
    const input = { schemaVersion: 1, accountId: 'calendar-main', planRevisionId: plan.id,
      planDigest: plan.planDigest, providerRequestId: `request-calendar-hold-${suffix}`,
      currency: 'CNY', optionId, startsAt: SESSION_START, endsAt: SESSION_END }
    return executionContext(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY, input, calendarTarget(), `hold-${suffix}`)
  }

  function calendarTarget() {
    return { kind: 'life_calendar', accountId: 'calendar-main', calendarId: 'calendar-main',
      planDigest: plan.planDigest, currency: 'CNY' }
  }

  function planInput() {
    return { schemaVersion: 1, planRevisionId: plan.id, planDigest: plan.planDigest,
      constraintSnapshotId: plan.constraintSnapshotId, constraintDigest: plan.constraintDigest,
      currency: 'CNY', activeAt: NOW }
  }
})

const EXECUTOR = 'life-shadow-test'
const NOW = '2026-07-15T10:00:00.000Z'
const SESSION_START = '2026-07-15T11:00:00.000Z'
const SESSION_END = '2026-07-15T12:00:00.000Z'
const TOMORROW = '2026-07-16T10:00:00.000Z'

function seedPlan(): { plan: LifePlanRevision; optionId: string } {
  const option = recordLifeOption({ accountId: 'games-main', kind: 'game', source: 'virtual-games',
    providerItemId: 'planned-game-001', title: 'Planned puzzle', categoryTags: ['puzzle'], durationMinutes: 60,
    exertion: 'low', screenBased: true, locationClass: 'home', cost: { currency: 'CNY', amountMinor: 500 },
    available: true, observedAt: NOW, expiresAt: TOMORROW, sourceDigest: '1'.repeat(64) })
  const constraint = createLifeConstraintSnapshot({ subjectId: 'person:self',
    horizon: { startsAt: SESSION_START, endsAt: '2026-07-15T13:00:00.000Z' }, timezone: 'Asia/Shanghai',
    freeWindows: [{ startsAt: SESSION_START, endsAt: '2026-07-15T13:00:00.000Z' }], commitmentIds: [],
    readiness: 'normal', recovery: 'good', sleepDebt: 'none', screenTimeUsedMinutes: 0,
    screenTimeLimitMinutes: 180, leisureTimeLimitMinutes: 120,
    budget: { currency: 'CNY', amountMinor: 2_000 }, quietStartMinute: 1_380, quietEndMinute: 420,
    maxTravelRadiusKm: 20, excludedCategories: [], preferredCategories: ['puzzle'], factRefs: [],
    createdAt: NOW, expiresAt: TOMORROW })
  const plan = createLifePlanRevision({ constraintSnapshotId: constraint.id,
    candidates: [{ optionId: option.id, eligible: true, score: 100, exclusionCodes: [],
      rationaleCodes: ['PREFERENCE_MATCH'] }],
    sessions: [{ optionId: option.id, startsAt: SESSION_START, endsAt: SESSION_END,
      cost: { currency: 'CNY', amountMinor: 500 }, rationaleCodes: ['PREFERENCE_MATCH'] }], createdAt: NOW })
  return { plan, optionId: option.id }
}

function gameProviderRecord(providerItemId: string) {
  return { recordKind: 'option' as const, providerItemId, kind: 'game' as const, source: 'virtual-games',
    title: `Puzzle ${providerItemId}`, categoryTags: ['puzzle'], durationMinutes: 30, exertion: 'low' as const,
    screenBased: true, locationClass: 'home' as const, cost: { currency: 'CNY', amountMinor: 0 },
    available: true, validForMinutes: 1_440 }
}

function subscriptionProviderRecord() {
  return { recordKind: 'subscription' as const, providerSubscriptionId: 'provider-subscription-001',
    serviceLabel: 'Music service', planLabel: 'Plus', recurringCost: { currency: 'CNY', amountMinor: 1_500 },
    renewalAt: TOMORROW, cancellationDeadline: '2026-07-16T09:00:00.000Z', state: 'active' as const }
}

function executionContext(capabilityId: string, input: Record<string, unknown>,
  target: Record<string, unknown>, suffix: string): FabricExecutionContext {
  const resolved = resolveFabricExecutor(capabilityId, { environments: ['sandbox'], executorId: EXECUTOR })!
  return { intentId: `intent-${suffix}`, workflowId: `workflow-${suffix}`, stepId: `step-${suffix}`,
    executorId: resolved.executor.id, executorType: resolved.executor.type, capabilityId,
    capabilityVersion: resolved.capability.version, contractDigest: resolved.capability.contractDigest,
    policyEvaluationToken: resolved.policyEvaluationToken, executionToken: `execution-${suffix}`,
    input, target, now: NOW }
}
