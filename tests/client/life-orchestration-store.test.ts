// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => Object.fromEntries([
  'fetchLifeOverview', 'fetchLifeCommitments', 'fetchLifeContacts', 'fetchLifeOptions',
  'fetchLifeSubscriptions', 'fetchLifeConstraints', 'fetchLifePlans', 'fetchLifeHandoffs',
  'fetchLifeHolds', 'fetchLifeCancellations', 'fetchLifeWorkflows', 'fetchLifeWorkflow',
  'fetchLifeTakeovers', 'fetchLifeActivationReviews', 'createLifeSource', 'syncLifeSource',
  'createLifeConstraint', 'createLifePlan', 'verifyLifePlan', 'createLifeHold', 'cancelLifeHold',
  'cancelLifeSubscription', 'reviewLifeWorkflow', 'updateLifeSourceHealth', 'activateLifeSource',
  'revokeLifeSource',
].map(name => [name, vi.fn()])))
vi.mock('@/api/hermes/life-orchestration', () => api)
import { useLifeOrchestrationStore } from '@/stores/hermes/life-orchestration'

const now = '2026-07-15T00:00:00.000Z'
const source = { id: 'calendar-1', sourceKind: 'calendar', mode: 'shadow', executorId: 'life-shadow',
  displayName: 'Calendar', health: 'healthy', enabled: true, policyEpoch: 1, version: 1,
  createdAt: now, updatedAt: now, revokedAt: null }
const constraint = { id: 'constraint-1', subjectId: 'self', horizon: { startsAt: now, endsAt: '2026-07-16T00:00:00.000Z' },
  timezone: 'Asia/Shanghai', freeWindows: [], commitmentIds: [], readiness: 'normal', recovery: 'good', sleepDebt: 'none',
  screenTimeUsedMinutes: 0, screenTimeLimitMinutes: 120, leisureTimeLimitMinutes: 180,
  budget: { currency: 'CNY', amountMinor: 10000 }, quietStartMinute: 1320, quietEndMinute: 420,
  maxTravelRadiusKm: 30, excludedCategories: [], preferredCategories: ['music'], factRefs: [],
  materialDigest: 'a'.repeat(64), createdAt: now, expiresAt: '2026-07-16T00:00:00.000Z' }
const plan = { id: 'plan-1', constraintSnapshotId: constraint.id, constraintDigest: constraint.materialDigest,
  candidates: [], sessions: [], totalMinutes: 0, totalCost: { currency: 'CNY', amountMinor: 0 },
  planDigest: 'b'.repeat(64), state: 'proposed', version: 1, createdAt: now, updatedAt: now }
const workflow = { id: 'workflow-1', capabilityId: 'life.source.sync', state: 'preparing', version: 1,
  attempt: 0, lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null,
  availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false } }
const overview = { runtime: { configuredAccountCount: 1, sourceExecutorEnabled: false, shadowExecutorEnabled: true,
  liveExecutorEnabled: false, authorizedTargetCount: 1, emergencyStopped: false }, accounts: [source],
  plans: [plan], workflows: [workflow], holds: [], cancellations: [], takeovers: [],
  summary: { accountCount: 1, liveAccountCount: 0, activePlanCount: 1, activeWorkflowCount: 1, pendingTakeoverCount: 0 } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

describe('life orchestration store', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks(); api.fetchLifeOverview.mockResolvedValue(overview)
    for (const method of ['fetchLifeCommitments', 'fetchLifeContacts', 'fetchLifeOptions', 'fetchLifeSubscriptions',
      'fetchLifeHandoffs', 'fetchLifeHolds', 'fetchLifeCancellations', 'fetchLifeTakeovers', 'fetchLifeActivationReviews']) {
      api[method].mockResolvedValue([])
    }
    api.fetchLifeConstraints.mockResolvedValue([constraint]); api.fetchLifePlans.mockResolvedValue([plan])
    api.fetchLifeWorkflows.mockResolvedValue([workflow])
  })

  it('loads the overview first and then every bounded semantic projection', async () => {
    const store = useLifeOrchestrationStore(); await store.loadDashboard()
    expect(store.selectedSourceId).toBe(source.id); expect(store.selectedPlanId).toBe(plan.id)
    expect(api.fetchLifeOverview.mock.invocationCallOrder[0]).toBeLessThan(api.fetchLifeOptions.mock.invocationCallOrder[0])
    expect(api.fetchLifeCommitments).toHaveBeenCalledWith(); expect(api.fetchLifeSubscriptions).toHaveBeenCalledWith()
  })

  it('serializes actions for one plan and remembers the newest workflow', async () => {
    const pending = deferred<any>(); api.verifyLifePlan.mockImplementationOnce(() => pending.promise)
    api.createLifeHold.mockResolvedValue({ workflow: { ...workflow, id: 'workflow-2' } })
    const store = useLifeOrchestrationStore()
    const first = store.verifyPlan({ planRevisionId: plan.id, activeAt: now, idempotencyKey: 'verify-123', rationale: 'verify' })
    const second = store.createHold({ accountId: source.id, planRevisionId: plan.id, optionId: 'option-1',
      providerRequestId: 'hold-request-1', idempotencyKey: 'hold-intent-1', rationale: 'hold' })
    await Promise.resolve(); expect(api.createLifeHold).not.toHaveBeenCalled()
    pending.resolve({ workflow }); await Promise.all([first, second])
    expect(store.selectedWorkflowId).toBe('workflow-2')
  })

  it('keeps a newer workflow selection when an older detail arrives last', async () => {
    const stale = deferred<any>(); api.fetchLifeWorkflow.mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ...workflow, id: 'workflow-2', policyDecision: null, steps: [] })
    const store = useLifeOrchestrationStore(); const first = store.loadWorkflow('workflow-1')
    await store.loadWorkflow('workflow-2'); stale.resolve({ ...workflow, policyDecision: null, steps: [] }); await first
    expect(store.selectedWorkflowId).toBe('workflow-2')
  })

  it('detects frozen-plan material changes and stores no provider identities or raw contact channels', async () => {
    api.fetchLifeConstraints.mockResolvedValue([{ ...constraint, id: 'constraint-2', materialDigest: 'c'.repeat(64) }])
    const store = useLifeOrchestrationStore(); await store.loadDashboard()
    expect(store.planMaterialChanged).toBe(true)
    expect(JSON.stringify(store.$state)).not.toMatch(/providerRequestId|providerHoldId|providerSubscriptionId|providerReceiptId|phone|email|cookie|credential|rawPayload/i)
  })
})
