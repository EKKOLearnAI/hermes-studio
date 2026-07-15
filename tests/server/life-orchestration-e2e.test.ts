import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveFabricWorkflow,
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  getFabricControlState,
  getFabricWorkflow,
  listFabricWorkflows,
  processActionFabricOnce,
  registerFabricExecutorAdapter,
  retryFabricWorkflow,
  setFabricEmergencyStop,
  unregisterFabricExecutorAdapter,
  type FabricActionIntentInput,
  type FabricJsonObject,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  buildLifeConstraintSnapshot,
  configureLifeRuntimeBindings,
  createConfiguredLifeExecutorAdapters,
  createLifeSourceAccount,
  getLifeSourceAccount,
  importBilibiliLifeOptions,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CAPABILITY_IDS,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SHADOW_EXECUTOR_ID,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
  lifeSubscriptionMaterialDigest,
  listLifeCalendarHolds,
  listLifeCommitments,
  listLifeContactAliases,
  listLifeHandoffs,
  listLifeOptions,
  listLifeSubscriptionCancellations,
  listLifeSubscriptions,
  planLifeLeisure,
  reconcileLifeRuntime,
  revokeLifeSourceAccount,
  stopLifeRuntime,
  verifyLifePlanRevision,
  VirtualLifeSourceProvider,
  type LifePlanRevision,
  type LifeRuntimeBinding,
  type LifeSourceKind,
  type VirtualLifeCatalogRecord,
} from '../../packages/server/src/services/hermes/life-orchestration'
import {
  listTwinEntities,
  listTwinEvents,
  listTwinRelations,
  recordTwinObservation,
  setTwinPreference,
  upsertTwinEntity,
  writeTwinProjection,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('life and entertainment orchestration end-to-end', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  let providerNow = NOW
  let workerTick = 0
  let registeredAdapters: string[] = []
  let providers: Map<string, VirtualLifeSourceProvider>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-e2e-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'life-e2e-managed-audit-key-at-least-32-bytes'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    providerNow = NOW
    workerTick = 0
    ensureBuiltInFabricRegistry()
    for (const executorId of ['life-source', LIFE_SHADOW_EXECUTOR_ID, 'life-live']) {
      unregisterFabricExecutorAdapter(executorId)
    }
    providers = new Map(SOURCE_KINDS.map(sourceKind => {
      const accountId = accountIdFor(sourceKind)
      createLifeSourceAccount({ id: accountId, sourceKind, mode: 'shadow', executorId: LIFE_SHADOW_EXECUTOR_ID,
        displayName: `${sourceKind} source` })
      return [accountId, new VirtualLifeSourceProvider({ sourceKind, records: recordsFor(sourceKind),
        clock: () => new Date(providerNow) })] as const
    }))
    configureLifeRuntimeBindings(runtimeBindings())
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 6,
      shadowExecutorEnabled: true, liveExecutorEnabled: false, emergencyStopped: false })
    registerLifeAdapters()
  })

  afterEach(() => {
    unregisterLifeAdapters()
    try { stopLifeRuntime() } catch { /* the temporary registry may already be unavailable after a failed assertion */ }
    configureLifeRuntimeBindings(null)
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('closes observation, planning, approval, recovery, cancellation, isolation, and safety controls', async () => {
    for (const sourceKind of SOURCE_KINDS) {
      const output = await runAllowedIntent(sourceSyncIntent(sourceKind, 'initial'))
      expect(output).toMatchObject({ operation: 'source_sync', sourceKind, status: 'succeeded', totalCount: 1 })
    }
    const subscription = listLifeSubscriptions({ accountId: 'subscriptions-main' })[0]!
    configureLifeRuntimeBindings(runtimeBindings([subscription.id]))
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 6, shadowExecutorEnabled: true })

    upsertTwinEntity({ id: 'entertainment:bilibili:BV1LIFEE2E01', type: 'entertainment',
      label: 'A documentary', source: 'bilibili', sourceId: 'video:BV1LIFEE2E01', attributes: {
        schemaVersion: 1, kind: 'video', provider: 'bilibili', bvid: 'BV1LIFEE2E01',
        title: 'A documentary', durationSeconds: 1_800, discoveredAt: NOW, resultDigest: 'b'.repeat(64),
      } })
    expect(importBilibiliLifeOptions()).toEqual([expect.objectContaining({ kind: 'video', source: 'bilibili',
      providerItemId: 'BV1LIFEE2E01', durationMinutes: 30 })])
    seedTwinConstraints()

    const constraint = buildLifeConstraintSnapshot({
      horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END }, timezone: 'UTC',
      policy: { budget: { currency: 'CNY', amountMinor: 1_000 }, screenTimeLimitMinutes: 180,
        leisureTimeLimitMinutes: 90, quietStartMinute: 1_380, quietEndMinute: 420,
        maxTravelRadiusKm: 20, excludedCategories: [], preferredCategories: [] },
      createdAt: NOW, expiresAt: TOMORROW,
    })
    expect(constraint).toMatchObject({ readiness: 'high', recovery: 'good', sleepDebt: 'none',
      screenTimeUsedMinutes: 60, budget: { currency: 'CNY', amountMinor: 1_000 },
      preferredCategories: ['puzzle', 'video'], freeWindows: [
        { startsAt: HORIZON_START, endsAt: COMMITMENT_START },
        { startsAt: COMMITMENT_END, endsAt: HORIZON_END },
      ] })

    const planned = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW, maxSessions: 3 })
    expect(planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW, maxSessions: 3 })).toEqual(planned)
    expect(planned.plan).toMatchObject({ totalMinutes: 90,
      totalCost: { currency: 'CNY', amountMinor: 500 }, sessions: expect.any(Array) })
    expect(planned.plan.sessions).toHaveLength(3)
    const travel = listLifeOptions({ kind: 'travel' })[0]!
    expect(planned.plan.candidates.find(item => item.optionId === travel.id)).toMatchObject({
      eligible: false, exclusionCodes: expect.arrayContaining(['BUDGET_EXCEEDED']),
    })
    expect(new Set(planned.handoffs.map(item => item.kind))).toEqual(new Set(['commerce', 'internet', 'android']))
    expect(planned.handoffs.every(item => item.state === 'proposed')).toBe(true)
    expect([...listLifeHandoffs(planned.plan.id)].sort(byId)).toEqual([...planned.handoffs].sort(byId))
    reconcileLifeRuntime()

    const planOutput = await runAllowedIntent(planVerifyIntent(planned.plan, 'initial'))
    expect(planOutput).toMatchObject({ operation: 'plan_verify', valid: true, reasonCodes: [] })

    const session = planned.plan.sessions[0]!
    const holdInput = calendarHoldIntent(planned.plan, session, 'uncertain-restart')
    const holdWorkflow = createFabricIntent(holdInput)
    expect(holdWorkflow.policyDecision).toMatchObject({ outcome: 'waiting_user',
      reasonCodes: expect.arrayContaining(['risk_requires_approval']) })
    expect(approveFabricWorkflow(holdWorkflow.workflow.id, ACTOR).state).toBe('preparing')
    await runWorkerPhase(holdWorkflow.workflow.id, 'prepare')

    providers.get('calendar-main')!.injectFault('create_calendar_hold', 'effect_before_timeout')
    unregisterLifeAdapters()
    registerLifeAdapters()
    await runWorkerPhase(holdWorkflow.workflow.id, 'execute')
    expect(getFabricWorkflow(holdWorkflow.workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_EXECUTION_OUTCOME_UNKNOWN',
    })
    expect(listLifeCalendarHolds()).toEqual([expect.objectContaining({ state: 'lookup_required' })])
    expect(retryFabricWorkflow(holdWorkflow.workflow.id, ACTOR).state).toBe('verifying')
    await runWorkerPhase(holdWorkflow.workflow.id, 'verify')
    const recoveredWorkflow = getFabricWorkflow(holdWorkflow.workflow.id)
    if (recoveredWorkflow?.state !== 'succeeded') {
      throw new Error(`LIFE_E2E_RECOVERY_FAILED:${recoveredWorkflow?.state ?? 'missing'}:${recoveredWorkflow?.lastErrorCode ?? 'none'}`)
    }
    expect(listLifeCalendarHolds()).toEqual([expect.objectContaining({ state: 'confirmed',
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })])
    expect(createFabricIntent(holdInput).workflow.id).toBe(holdWorkflow.workflow.id)
    unregisterLifeAdapters()
    stopLifeRuntime()
    expect(reconcileLifeRuntime()).toMatchObject({ configuredAccountCount: 6, shadowExecutorEnabled: true })
    registerLifeAdapters()
    expect(getFabricWorkflow(holdWorkflow.workflow.id)).toMatchObject({ state: 'succeeded' })
    expect(listLifeCalendarHolds()).toHaveLength(1)

    const cancellation = createFabricIntent(subscriptionCancelIntent(subscription.id,
      lifeSubscriptionMaterialDigest(subscription), 'cancel'))
    expect(cancellation.policyDecision).toMatchObject({ outcome: 'waiting_user' })
    approveFabricWorkflow(cancellation.workflow.id, ACTOR)
    await runWorkflowToSuccess(cancellation.workflow.id)
    expect(executeOutput(cancellation.workflow.id)).toMatchObject({ operation: 'subscription_cancel',
      subscriptionId: subscription.id, state: 'cancelled', receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(listLifeSubscriptionCancellations()).toEqual([expect.objectContaining({ state: 'cancelled' })])

    const receivingCapabilities = new Set(planned.handoffs.map(item => item.targetCapabilityId))
    expect(listFabricWorkflows({ limit: 200 }).filter(item => receivingCapabilities.has(item.capabilityId))).toEqual([])
    expect(listFabricWorkflows({ limit: 200 }).every(item => LIFE_CAPABILITY_IDS.includes(item.capabilityId as never)))
      .toBe(true)

    providerNow = CHANGED
    providers.get('games-main')!.replaceRecords([{ ...recordsFor('games')[0]!, title: 'Changed puzzle' }])
    providers.get('calendar-main')!.replaceRecords([{ ...recordsFor('calendar')[0]!, label: 'Changed work block' }])
    await runAllowedIntent(sourceSyncIntent('games', 'changed'))
    await runAllowedIntent(sourceSyncIntent('calendar', 'changed'))
    expect(verifyLifePlanRevision({ planId: planned.plan.id, activeAt: CHANGED })).toMatchObject({ valid: false,
      reasonCodes: ['COMMITMENT_MATERIAL_CHANGED', 'OPTION_MATERIAL_CHANGED'] })

    expect(listLifeContactAliases()).toHaveLength(1)
    expect(listLifeCommitments()).toHaveLength(2)
    expect(listLifeCommitments().every(item => item.participantAliasIds[0] === listLifeContactAliases()[0]!.id))
      .toBe(true)
    expect(listTwinEntities({ type: 'life' }).length).toBeGreaterThanOrEqual(2)
    expect(listTwinEntities({ type: 'entertainment' }).length).toBeGreaterThanOrEqual(4)
    expect(listTwinEvents({ eventTypePrefixes: ['life.', 'entertainment.'] }).length).toBeGreaterThanOrEqual(6)
    expect(listTwinRelations({ subjectId: 'person:self' }).length).toBeGreaterThanOrEqual(6)

    const gamesAccount = getLifeSourceAccount('games-main')!
    revokeLifeSourceAccount({ accountId: gamesAccount.id, actorUserId: 'admin-e2e', actorIsSuperAdmin: true,
      expectedVersion: gamesAccount.version, now: CHANGED })
    reconcileLifeRuntime()
    expect(createFabricIntent(sourceSyncIntent('games', 'revoked')).policyDecision).toMatchObject({ outcome: 'deny' })

    const control = getFabricControlState()
    setFabricEmergencyStop(3, 'admin-e2e', 'stop life writes', control.version)
    expect(reconcileLifeRuntime()).toMatchObject({ emergencyStopped: true })
    expect(createFabricIntent(calendarHoldIntent(planned.plan, session, 'emergency')).policyDecision)
      .toMatchObject({ outcome: 'deny', reasonCodes: ['emergency_stop'] })

    const exposed = JSON.stringify({ holds: listLifeCalendarHolds(),
      cancellations: listLifeSubscriptionCancellations(), workflows: listFabricWorkflows({ limit: 200 }) })
    expect(exposed).not.toContain('life-e2e-managed-audit-key-at-least-32-bytes')
  }, 30_000)

  function runtimeBindings(subscriptionIds: string[] = []): LifeRuntimeBinding[] {
    return SOURCE_KINDS.map(sourceKind => ({ accountId: accountIdFor(sourceKind),
      provider: providers.get(accountIdFor(sourceKind))!, currency: 'CNY',
      subscriptionIds: sourceKind === 'subscriptions' ? subscriptionIds : [] }))
  }

  function registerLifeAdapters(): void {
    for (const adapter of createConfiguredLifeExecutorAdapters()) {
      registerFabricExecutorAdapter(adapter)
      registeredAdapters.push(adapter.id)
    }
  }

  function unregisterLifeAdapters(): void {
    for (const id of registeredAdapters.splice(0).reverse()) unregisterFabricExecutorAdapter(id)
  }

  async function runAllowedIntent(input: FabricActionIntentInput): Promise<FabricJsonObject> {
    const created = createFabricIntent(input)
    expect(created.policyDecision).toMatchObject({ outcome: 'allow' })
    await runWorkflowToSuccess(created.workflow.id)
    return executeOutput(created.workflow.id)
  }

  async function runWorkflowToSuccess(workflowId: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (getFabricWorkflow(workflowId)?.state === 'succeeded') return
      workerTick += 1
      const result = await processActionFabricOnce({ workerId: 'life-e2e-worker',
        now: new Date(Date.parse(NOW) + workerTick * 1_000) })
      expect(result).toMatchObject({ processed: true, workflowId })
    }
    expect(getFabricWorkflow(workflowId)).toMatchObject({ state: 'succeeded' })
  }

  async function runWorkerPhase(workflowId: string, phase: 'prepare' | 'execute' | 'verify'): Promise<void> {
    workerTick += 1
    const result = await processActionFabricOnce({ workerId: 'life-e2e-worker',
      now: new Date(Date.parse(NOW) + workerTick * 1_000) })
    if (!result.processed) {
      const workflow = getFabricWorkflow(workflowId)
      throw new Error(`LIFE_E2E_WORKER_STALLED:${phase}:${workflow?.state ?? 'missing'}:${workflow?.lastErrorCode ?? 'none'}`)
    }
    expect(result).toMatchObject({ processed: true, workflowId, phase })
  }
})

const SOURCE_KINDS = ['contacts', 'calendar', 'travel', 'music', 'games', 'subscriptions'] as const
const NOW = '2026-07-15T10:00:00.000Z'
const HORIZON_START = '2026-07-15T11:00:00.000Z'
const COMMITMENT_START = '2026-07-15T11:30:00.000Z'
const COMMITMENT_END = '2026-07-15T12:00:00.000Z'
const HORIZON_END = '2026-07-15T14:00:00.000Z'
const CHANGED = '2026-07-15T10:05:00.000Z'
const TOMORROW = '2026-07-16T10:00:00.000Z'
const ACTOR = 'user-life-e2e'

function accountIdFor(sourceKind: LifeSourceKind): string { return `${sourceKind}-main` }
function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function recordsFor(sourceKind: LifeSourceKind): VirtualLifeCatalogRecord[] {
  if (sourceKind === 'contacts') return [{ recordKind: 'contact', providerContactId: 'contact-e2e',
    alias: 'Friend E2E', relationshipTags: ['friend'], availabilityTags: ['evening'] }]
  if (sourceKind === 'calendar') return [{ recordKind: 'commitment', providerItemId: 'event-e2e',
    label: 'Work block', category: 'work', startsAt: COMMITMENT_START, endsAt: COMMITMENT_END,
    allDay: false, busy: true, locationClass: 'remote', participantProviderContactIds: ['contact-e2e'],
    validForMinutes: 1_440 }]
  if (sourceKind === 'subscriptions') return [{ recordKind: 'subscription',
    providerSubscriptionId: 'subscription-e2e', serviceLabel: 'Music service', planLabel: 'Plus',
    recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: TOMORROW,
    cancellationDeadline: '2026-07-16T09:00:00.000Z', state: 'active' }]
  if (sourceKind === 'travel') return [optionRecord('travel', 'travel-e2e', 60, false, 5_000, ['travel'])]
  if (sourceKind === 'music') return [optionRecord('music', 'music-e2e', 30, false, null, ['ambient'])]
  return [optionRecord('game', 'game-e2e', 30, true, 500, ['puzzle'])]
}

function optionRecord(kind: 'travel' | 'music' | 'game', providerItemId: string, durationMinutes: number,
  screenBased: boolean, amountMinor: number | null, categoryTags: string[]): VirtualLifeCatalogRecord {
  const sourceKind = kind === 'game' ? 'games' : kind
  return { recordKind: 'option', providerItemId, kind, source: `virtual-${sourceKind}`,
    title: `${kind} option`, categoryTags, durationMinutes, exertion: 'low', screenBased,
    locationClass: kind === 'travel' ? 'local' : 'home',
    cost: amountMinor === null ? null : { currency: 'CNY', amountMinor }, available: true,
    validForMinutes: 1_440 }
}

function seedTwinConstraints(): void {
  writeTwinProjection({ key: 'health.readiness_state', subjectId: 'person:self', value: {
    schemaVersion: 1, computedAt: '2026-07-15T09:30:00.000Z', state: { status: 'ready', score: 88 },
    freshness: { status: 'fresh' }, conflictCount: 0,
  }, sourceRecordId: 'health-readiness-e2e', updatedAt: '2026-07-15T09:30:00.000Z' })
  writeTwinProjection({ key: 'health.recovery_state', subjectId: 'person:self', value: {
    schemaVersion: 1, computedAt: '2026-07-15T09:30:00.000Z',
    state: { current: { recovery_score: { value: 91 }, duration_minutes: { value: 450 } } },
    freshness: { status: 'fresh' }, conflictCount: 0,
  }, sourceRecordId: 'health-recovery-e2e', updatedAt: '2026-07-15T09:30:00.000Z' })
  recordTwinObservation({ entityId: 'person:self', metric: 'digital.screen_time.used_minutes', value: 60,
    unit: 'min', observedAt: '2026-07-15T09:30:00.000Z', source: 'digital', sourceId: 'screen-e2e',
    actor: 'system', confidence: 1, confirmationState: 'observed' })
  setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'preferred_categories',
    value: ['puzzle', 'video'], source: 'user', sourceId: 'life-preferences-e2e', actor: 'user:self' })
  setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'excluded_categories',
    value: ['horror'], source: 'user', sourceId: 'life-exclusions-e2e', actor: 'user:self' })
}

function sourceSyncIntent(sourceKind: LifeSourceKind, suffix: string): FabricActionIntentInput {
  const accountId = accountIdFor(sourceKind)
  return lifeIntent(LIFE_SOURCE_SYNC_CAPABILITY,
    { schemaVersion: 1, accountId, sourceKind, cursor: null, limit: 20 },
    { kind: 'life_source', accountId, sourceKind }, `sync-${sourceKind}-${suffix}`)
}

function planVerifyIntent(plan: LifePlanRevision, suffix: string): FabricActionIntentInput {
  return lifeIntent(LIFE_PLAN_VERIFY_CAPABILITY, { schemaVersion: 1, planRevisionId: plan.id,
    planDigest: plan.planDigest, constraintSnapshotId: plan.constraintSnapshotId,
    constraintDigest: plan.constraintDigest, currency: plan.totalCost.currency, activeAt: NOW },
  { kind: 'life_plan', planDigest: plan.planDigest, currency: plan.totalCost.currency }, `plan-${suffix}`)
}

function calendarHoldIntent(plan: LifePlanRevision, session: LifePlanRevision['sessions'][number],
  suffix: string): FabricActionIntentInput {
  return lifeIntent(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY, { schemaVersion: 1, accountId: 'calendar-main',
    planRevisionId: plan.id, planDigest: plan.planDigest, providerRequestId: `hold-request-${suffix}`,
    currency: plan.totalCost.currency, optionId: session.optionId,
    startsAt: session.startsAt, endsAt: session.endsAt },
  { kind: 'life_calendar', accountId: 'calendar-main', calendarId: 'calendar-main',
    planDigest: plan.planDigest, currency: plan.totalCost.currency }, `hold-${suffix}`)
}

function subscriptionCancelIntent(subscriptionId: string, subscriptionDigest: string,
  suffix: string): FabricActionIntentInput {
  return lifeIntent(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, { schemaVersion: 1,
    accountId: 'subscriptions-main', subscriptionId, subscriptionDigest,
    providerRequestId: `subscription-request-${suffix}`, reasonCode: 'USER_REQUEST', currency: 'CNY' },
  { kind: 'life_subscription', accountId: 'subscriptions-main', subscriptionId, currency: 'CNY' },
  `subscription-${suffix}`)
}

function lifeIntent(capabilityId: string, input: FabricJsonObject, target: FabricJsonObject,
  suffix: string): FabricActionIntentInput {
  return { capabilityId, requestedByRoleId: 'entertainment-assistant', requestedByUserId: ACTOR,
    idempotencyKey: `life-e2e-${suffix}`, goal: `Life E2E ${suffix}`, target, input,
    constraints: {}, rationale: 'Verify the governed life orchestration closed loop', environments: ['sandbox'] }
}

function executeOutput(workflowId: string): FabricJsonObject {
  const workflow = getFabricWorkflow(workflowId)
  expect(workflow).toMatchObject({ state: 'succeeded' })
  const output = workflow?.steps.find(step => step.kind === 'execute')?.output
  if (!output) throw new Error('LIFE_E2E_EXECUTION_OUTPUT_MISSING')
  return output
}
