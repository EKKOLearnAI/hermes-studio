import { beforeEach, describe, expect, it, vi } from 'vitest'

const fabric = vi.hoisted(() => ({
  createFabricIntent: vi.fn(), getFabricWorkflow: vi.fn(), listFabricWorkflows: vi.fn(),
}))
const life = vi.hoisted(() => ({
  LIFE_ASSISTANT_ROLE_ID: 'entertainment-assistant',
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY: 'life.calendar.hold.cancel',
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY: 'life.calendar.hold.create',
  LIFE_CAPABILITY_IDS: ['life.source.sync', 'life.plan.verify', 'life.calendar.hold.create',
    'life.calendar.hold.cancel', 'life.subscription.cancel'],
  LIFE_PLAN_VERIFY_CAPABILITY: 'life.plan.verify', LIFE_SHADOW_EXECUTOR_ID: 'life-shadow',
  LIFE_SOURCE_EXECUTOR_ID: 'life-source', LIFE_SOURCE_SYNC_CAPABILITY: 'life.source.sync',
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY: 'life.subscription.cancel',
  LifeContractError: class LifeContractError extends Error {},
  buildLifeConstraintSnapshot: vi.fn(), createLifeSourceAccount: vi.fn(), getLifeCalendarHold: vi.fn(),
  getLifeConstraintSnapshot: vi.fn(), getLifePlanRevision: vi.fn(), getLifeRuntimeStatus: vi.fn(),
  getLifeSourceAccount: vi.fn(), getLifeSubscription: vi.fn(), lifeSubscriptionMaterialDigest: vi.fn(),
  listLifeActivationReviews: vi.fn(), listLifeCalendarHolds: vi.fn(), listLifeCommitments: vi.fn(),
  listLifeConstraintSnapshots: vi.fn(), listLifeContactAliases: vi.fn(), listLifeHandoffs: vi.fn(),
  listLifeOptions: vi.fn(), listLifePlanRevisions: vi.fn(), listLifeSourceAccounts: vi.fn(),
  listLifeSubscriptionCancellations: vi.fn(), listLifeSubscriptions: vi.fn(), planLifeLeisure: vi.fn(),
  reconcileLifeRuntime: vi.fn(), revokeLifeSourceAccount: vi.fn(), transitionLifeSourceAccountMode: vi.fn(),
  updateLifeSourceAccountHealth: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric', () => fabric)
vi.mock('../../packages/server/src/services/hermes/life-orchestration', () => life)

const now = '2026-07-15T00:00:00.000Z'
const account = { id: 'life-calendar-1', sourceKind: 'calendar', mode: 'shadow', executorId: 'life-shadow',
  displayName: 'Calendar', health: 'healthy', enabled: true, policyEpoch: 3, version: 2,
  createdAt: now, updatedAt: now, revokedAt: null }
const subscriptionAccount = { ...account, id: 'life-subscriptions-1', sourceKind: 'subscriptions' }
const plan = { id: 'plan-1', revision: 1, constraintSnapshotId: 'constraint-1',
  constraintDigest: 'a'.repeat(64), candidates: [], sessions: [{ optionId: 'option-1', startsAt: now,
    endsAt: '2026-07-15T01:00:00.000Z', cost: { currency: 'CNY', amountMinor: 0 }, rationaleCodes: [] }],
  totalCost: { currency: 'CNY', amountMinor: 0 }, state: 'proposed', supersedesId: null,
  planDigest: 'b'.repeat(64), createdAt: now, expiresAt: '2026-07-16T00:00:00.000Z' }
const subscription = { id: 'subscription-1', accountId: subscriptionAccount.id, providerSubscriptionId: 'provider-private',
  serviceLabel: 'Music', planLabel: 'Monthly', recurringCost: { currency: 'CNY', amountMinor: 1500 },
  renewalAt: '2026-08-01T00:00:00.000Z', cancellationDeadline: '2026-07-31T00:00:00.000Z', state: 'active',
  observedAt: now, sourceDigest: 'c'.repeat(64), version: 1 }
const hold = { id: 'hold-1', workflowId: 'workflow-1', accountId: account.id, planRevisionId: plan.id,
  planDigest: plan.planDigest, optionId: 'option-1', window: { startsAt: now, endsAt: '2026-07-15T01:00:00.000Z' },
  providerRequestId: 'provider-request-private', providerHoldId: 'provider-hold-private', receiptDigest: null,
  state: 'confirmed', policyEpoch: 3, version: 2, createdAt: now, updatedAt: now, completedAt: null }
const cancellation = { id: 'cancellation-1', workflowId: 'workflow-2', accountId: subscriptionAccount.id,
  subscriptionId: subscription.id, subscriptionDigest: 'd'.repeat(64), providerRequestId: 'cancel-request-private',
  reasonCode: 'NO_LONGER_NEEDED', providerReceiptId: 'provider-receipt-private', receiptDigest: null,
  state: 'requested', policyEpoch: 3, version: 1, createdAt: now, updatedAt: now, completedAt: null }
const workflow = { id: 'workflow-1', capabilityId: 'life.calendar.hold.create', requestedByRoleId: 'entertainment-assistant',
  requestedByUserId: '42', state: 'preparing', version: 1, attempt: 0, lastErrorCode: null,
  createdAt: now, updatedAt: now, completedAt: null,
  availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false },
  steps: [], policyDecision: null }
const intentResult = { intent: { id: 'intent-1', capabilityId: 'life.calendar.hold.create' },
  policyDecision: { id: 'decision-1', outcome: 'allow', reasonCodes: [] }, workflow }

function ctx(options: { body?: unknown; query?: Record<string, unknown>; id?: string } = {}): any {
  const request: Record<string, unknown> = { type: 'application/json' }
  if ('body' in options) request.body = options.body
  return { request, query: options.query ?? {}, params: { id: options.id ?? account.id },
    state: { user: { id: 42, role: 'super_admin' } }, body: null, status: 200 }
}

describe('life orchestration controller', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(fabric).forEach(mock => mock.mockReset())
    Object.values(life).filter(value => typeof value === 'function' && 'mockReset' in value)
      .forEach((mock: any) => mock.mockReset())
    life.getLifeSourceAccount.mockImplementation((id: string) => id === account.id ? account
      : id === subscriptionAccount.id ? subscriptionAccount : null)
    life.getLifePlanRevision.mockReturnValue(plan)
    life.getLifeSubscription.mockReturnValue(subscription)
    life.getLifeCalendarHold.mockReturnValue(hold)
    life.lifeSubscriptionMaterialDigest.mockReturnValue('d'.repeat(64))
    life.listLifeSourceAccounts.mockReturnValue([account, subscriptionAccount])
    life.listLifePlanRevisions.mockReturnValue([plan])
    life.listLifeCalendarHolds.mockReturnValue([hold])
    life.listLifeSubscriptionCancellations.mockReturnValue([cancellation])
    life.listLifeCommitments.mockReturnValue([])
    life.listLifeContactAliases.mockReturnValue([])
    life.listLifeOptions.mockReturnValue([])
    life.listLifeSubscriptions.mockReturnValue([subscription])
    life.listLifeConstraintSnapshots.mockReturnValue([])
    life.listLifeHandoffs.mockReturnValue([])
    life.listLifeActivationReviews.mockReturnValue([])
    life.getLifeRuntimeStatus.mockReturnValue({ configuredAccountCount: 2, sourceExecutorEnabled: true,
      shadowExecutorEnabled: true, liveExecutorEnabled: false, authorizedTargetCount: 2, emergencyStopped: false })
    fabric.listFabricWorkflows.mockReturnValue([workflow])
    fabric.createFabricIntent.mockReturnValue(intentResult)
  })

  it('returns minimized projections without provider identities or provider request ids', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const context = ctx()
    await ctrl.overview(context)
    const text = JSON.stringify(context.body)
    expect(context.body.summary).toMatchObject({ accountCount: 2, liveAccountCount: 0, activePlanCount: 1 })
    expect(text).not.toContain('provider-request-private')
    expect(text).not.toContain('provider-hold-private')
    expect(text).not.toContain('cancel-request-private')
    expect(text).not.toContain('provider-receipt-private')
  })

  it('creates only observe or shadow sources and derives the executor binding', async () => {
    life.createLifeSourceAccount.mockReturnValue(account)
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const context = ctx({ body: { id: account.id, sourceKind: 'calendar', mode: 'shadow',
      displayName: 'Calendar', enabled: true } })
    await ctrl.createSource(context)
    expect(context.status).toBe(201)
    expect(life.createLifeSourceAccount).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow', executorId: 'life-shadow',
    }))

    const live = ctx({ body: { id: account.id, sourceKind: 'calendar', mode: 'live', displayName: 'Calendar' } })
    await ctrl.createSource(live)
    expect(live.status).toBe(400)
    expect(life.createLifeSourceAccount).toHaveBeenCalledOnce()
  })

  it('derives calendar window, digest, currency, role, actor, target, and environment from server state', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const context = ctx({ body: { accountId: account.id, planRevisionId: plan.id, optionId: 'option-1',
      providerRequestId: 'hold-request-123', idempotencyKey: 'hold-intent-123', rationale: 'Reserve this session' } })
    await ctrl.createCalendarHold(context)
    expect(context.status).toBe(202)
    const request = fabric.createFabricIntent.mock.calls[0]![0]
    expect(request).toMatchObject({ capabilityId: 'life.calendar.hold.create',
      requestedByRoleId: 'entertainment-assistant', requestedByUserId: '42', environments: ['sandbox'],
      target: { kind: 'life_calendar', accountId: account.id, calendarId: account.id,
        planDigest: plan.planDigest, currency: 'CNY' } })
    expect(request.input).toMatchObject({ startsAt: now, endsAt: '2026-07-15T01:00:00.000Z',
      planDigest: plan.planDigest, currency: 'CNY' })
  })

  it('derives subscription digest, account, currency, role, actor, target, and environment from server state', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const context = ctx({ body: { subscriptionId: subscription.id, providerRequestId: 'cancel-request-123',
      reasonCode: 'NO_LONGER_NEEDED', idempotencyKey: 'cancel-intent-123', rationale: 'Cancel unused plan' } })
    await ctrl.cancelSubscription(context)
    expect(context.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({
      requestedByRoleId: 'entertainment-assistant', requestedByUserId: '42', environments: ['sandbox'],
      target: { kind: 'life_subscription', accountId: subscriptionAccount.id,
        subscriptionId: subscription.id, currency: 'CNY' },
      input: expect.objectContaining({ subscriptionDigest: 'd'.repeat(64), accountId: subscriptionAccount.id,
        currency: 'CNY' }),
    }))
  })

  it('uses the authenticated actor and server-owned super-admin assertion for activation', async () => {
    life.transitionLifeSourceAccountMode.mockReturnValue({ account, review: { id: 'review-1' } })
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const context = ctx({ body: { toMode: 'live', limits: { currency: 'CNY',
      calendarIds: [account.id], subscriptionIds: [] } } })
    await ctrl.activateSource(context)
    expect(life.transitionLifeSourceAccountMode).toHaveBeenCalledWith({ accountId: account.id, toMode: 'live',
      actorUserId: '42', actorIsSuperAdmin: true,
      limits: { currency: 'CNY', calendarIds: [account.id], subscriptionIds: [] } })
  })

  it('rejects unexpected and accessor-backed fields before invoking services', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    const unexpected = ctx({ body: { accountId: account.id, cursor: null, limit: 10,
      idempotencyKey: 'source-sync-123', rationale: 'Refresh calendar', credential: 'secret' } })
    await ctrl.syncSource(unexpected)
    expect(unexpected.status).toBe(400)

    let accessed = false
    const body: Record<string, unknown> = { accountId: account.id, cursor: null, limit: 10,
      idempotencyKey: 'source-sync-123' }
    Object.defineProperty(body, 'rationale', { enumerable: true,
      get: () => { accessed = true; return 'Refresh calendar' } })
    const accessor = ctx({ body })
    await ctrl.syncSource(accessor)
    expect(accessor.status).toBe(400)
    expect(accessed).toBe(false)
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()
  })

  it('filters workflow detail to the life role and capability namespace', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/life-orchestration')
    fabric.getFabricWorkflow.mockReturnValue({ ...workflow, requestedByRoleId: 'commerce-assistant' })
    const context = ctx({ id: workflow.id })
    await ctrl.workflow(context)
    expect(context).toMatchObject({ status: 404, body: { code: 'LIFE_WORKFLOW_NOT_FOUND' } })
  })
})
