import type { Context } from 'koa'
import { isProxy } from 'node:util/types'
import {
  createFabricIntent,
  getFabricWorkflow,
  listFabricWorkflows,
  type FabricIntentResult,
  type FabricWorkflowDetail,
  type FabricWorkflowSummary,
} from '../../services/hermes/action-fabric'
import { isFabricSensitiveString } from '../../services/hermes/action-fabric/audit'
import {
  LIFE_ASSISTANT_ROLE_ID,
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CAPABILITY_IDS,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SHADOW_EXECUTOR_ID,
  LIFE_SOURCE_EXECUTOR_ID,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
  LifeContractError,
  buildLifeConstraintSnapshot,
  createLifeSourceAccount,
  getLifeCalendarHold,
  getLifeConstraintSnapshot,
  getLifePlanRevision,
  getLifeRuntimeStatus,
  getLifeSourceAccount,
  getLifeSubscription,
  lifeSubscriptionMaterialDigest,
  listLifeActivationReviews,
  listLifeCalendarHolds,
  listLifeCommitments,
  listLifeConstraintSnapshots,
  listLifeContactAliases,
  listLifeHandoffs,
  listLifeOptions,
  listLifePlanRevisions,
  listLifeSourceAccounts,
  listLifeSubscriptionCancellations,
  listLifeSubscriptions,
  planLifeLeisure,
  reconcileLifeRuntime,
  revokeLifeSourceAccount,
  transitionLifeSourceAccountMode,
  updateLifeSourceAccountHealth,
  type LifeActivationLimits,
  type LifeSourceAccount,
} from '../../services/hermes/life-orchestration'

class LifeRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const CURRENCY = /^[A-Z]{3}$/
const MAX_LIST = 200
const MAX_BODY_BYTES = 32_768
const CAPABILITIES = new Set<string>(LIFE_CAPABILITY_IDS)

/** @openapi-default-errors 400:LifeApiError,401:AuthError,403:AuthError,404:LifeApiError,409:LifeApiError,422:LifeApiError,500:LifeApiError,503:LifeApiError */

/** @openapi-response LifeOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const accounts = listLifeSourceAccounts(MAX_LIST)
    const plans = listLifePlanRevisions({ limit: 20 })
    const workflows = lifeWorkflows(20)
    const holds = listLifeCalendarHolds({ limit: 20 })
    const cancellations = listLifeSubscriptionCancellations({ limit: 20 })
    return { runtime: getLifeRuntimeStatus(), accounts: accounts.map(publicAccount), plans: plans.map(publicPlan),
      workflows: workflows.map(publicWorkflow), holds: holds.map(publicHold),
      cancellations: cancellations.map(publicCancellation),
      takeovers: workflows.filter(item => item.state === 'waiting_user').map(publicTakeover),
      summary: { accountCount: accounts.length, liveAccountCount: accounts.filter(a => a.mode === 'live').length,
        activePlanCount: plans.filter(p => ['proposed', 'reserved'].includes(p.state)).length,
        activeWorkflowCount: workflows.filter(item => !terminalWorkflow(item.state)).length,
        pendingTakeoverCount: workflows.filter(item => item.state === 'waiting_user').length } }
  })
}

/** @openapi-response LifeSourceListResponse */
export async function sources(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['limit'])); return {
    sources: listLifeSourceAccounts(queryLimit(ctx)).map(publicAccount) } })
}

/** @openapi-response LifeSourceResponse */
export async function createSource(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['id', 'sourceKind', 'mode', 'displayName', 'enabled']))
    const mode = requiredEnum(body.mode, ['observe', 'shadow'] as const)
    const account = createLifeSourceAccount({ id: requiredId(body.id),
      sourceKind: requiredEnum(body.sourceKind,
        ['calendar', 'contacts', 'travel', 'music', 'games', 'subscriptions'] as const), mode,
      executorId: mode === 'shadow' ? LIFE_SHADOW_EXECUTOR_ID : LIFE_SOURCE_EXECUTOR_ID,
      displayName: requiredText(body.displayName, 160), enabled: optionalBoolean(body.enabled) ?? true })
    reconcileLifeRuntime(); ctx.status = 201
    return { source: publicAccount(account) }
  })
}

/** @openapi-response LifeSourceResponse */
export async function updateSourceHealth(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = exactBody(ctx, new Set(['health', 'expectedVersion']))
    const account = updateLifeSourceAccountHealth({ accountId: pathId(ctx),
      health: requiredEnum(body.health, ['unknown', 'healthy', 'degraded', 'unhealthy'] as const),
      expectedVersion: requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER) })
    reconcileLifeRuntime(); return { source: publicAccount(account) }
  })
}

/** @openapi-response LifeActivationReviewListResponse */
export async function activationReviews(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['limit'])); return {
    reviews: listLifeActivationReviews(pathId(ctx), queryLimit(ctx)).map(item => ({ ...item })) } })
}

/** @openapi-response LifeActivationResponse */
export async function activateSource(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = exactBody(ctx, new Set(['toMode', 'limits']))
    const result = transitionLifeSourceAccountMode({ accountId: pathId(ctx),
      toMode: requiredEnum(body.toMode, ['observe', 'shadow', 'live'] as const),
      actorUserId: actorUserId(ctx), actorIsSuperAdmin: true, limits: activationLimits(body.limits) })
    reconcileLifeRuntime(); return { source: publicAccount(result.account), review: { ...result.review } }
  })
}

/** @openapi-response LifeSourceResponse */
export async function revokeSource(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = exactBody(ctx, new Set(['expectedVersion']))
    const account = revokeLifeSourceAccount({ accountId: pathId(ctx), actorUserId: actorUserId(ctx),
      actorIsSuperAdmin: true, expectedVersion: requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER) })
    reconcileLifeRuntime(); return { source: publicAccount(account) }
  })
}

/** @openapi-response LifeActionResponse */
export async function syncSource(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = actionBody(ctx, new Set(['accountId', 'cursor', 'limit']))
    const account = requiredAccount(requiredId(body.accountId)); reconcileLifeRuntime()
    const cursor = body.cursor === null ? null : requiredCursor(body.cursor)
    return accepted(ctx, lifeIntent(ctx, account, LIFE_SOURCE_SYNC_CAPABILITY,
      { schemaVersion: 1, accountId: account.id, sourceKind: account.sourceKind, cursor,
        limit: requiredInteger(body.limit, 1, 20) },
      { kind: 'life_source', accountId: account.id, sourceKind: account.sourceKind }, body,
      'Synchronize one bounded life source page'))
  })
}

/** @openapi-response LifeCommitmentListResponse */
export async function commitments(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['accountId', 'limit'])); const accountId = queryId(ctx, 'accountId')
    return { commitments: listLifeCommitments({ ...(accountId ? { accountId } : {}), limit: queryLimit(ctx) })
      .map(publicCommitment) } })
}

/** @openapi-response LifeContactListResponse */
export async function contacts(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['accountId', 'limit'])); const accountId = queryId(ctx, 'accountId')
    return { contacts: listLifeContactAliases(accountId, queryLimit(ctx)).map(publicContact) } })
}

/** @openapi-response LifeOptionListResponse */
export async function options(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['kind', 'activeAt', 'limit']))
    const kind = queryEnum(ctx, 'kind', ['travel', 'video', 'music', 'game'] as const)
    const activeAt = queryTimestamp(ctx, 'activeAt')
    return { options: listLifeOptions({ ...(kind ? { kind } : {}), ...(activeAt ? { activeAt } : {}),
      limit: queryLimit(ctx) }).map(publicOption) } })
}

/** @openapi-response LifeSubscriptionListResponse */
export async function subscriptions(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['accountId', 'state', 'limit']))
    const accountId = queryId(ctx, 'accountId')
    const state = queryEnum(ctx, 'state', ['active', 'trial', 'paused', 'cancel_pending', 'cancelled', 'expired'] as const)
    return { subscriptions: listLifeSubscriptions({ ...(accountId ? { accountId } : {}),
      ...(state ? { state } : {}), limit: queryLimit(ctx) }).map(publicSubscription) } })
}

/** @openapi-response LifeConstraintListResponse */
export async function constraints(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['limit'])); return {
    constraints: listLifeConstraintSnapshots(queryLimit(ctx)).map(publicConstraint) } })
}

/** @openapi-response LifeConstraintResponse */
export async function createConstraint(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = exactBody(ctx, new Set(['subjectId', 'horizon', 'timezone', 'policy', 'createdAt',
      'expiresAt', 'healthFreshnessMs', 'screenTimeFreshnessMs', 'useTwinPreferences']))
    const snapshot = buildLifeConstraintSnapshot({
      ...(body.subjectId === undefined ? {} : { subjectId: requiredId(body.subjectId) }),
      horizon: timeWindow(body.horizon), timezone: requiredText(body.timezone, 100),
      policy: constraintPolicy(body.policy), createdAt: requiredTimestamp(body.createdAt),
      expiresAt: requiredTimestamp(body.expiresAt),
      ...(body.healthFreshnessMs === undefined ? {} : { healthFreshnessMs: requiredInteger(body.healthFreshnessMs, 1, 2_592_000_000) }),
      ...(body.screenTimeFreshnessMs === undefined ? {} : { screenTimeFreshnessMs: requiredInteger(body.screenTimeFreshnessMs, 1, 2_592_000_000) }),
      ...(body.useTwinPreferences === undefined ? {} : { useTwinPreferences: requiredBoolean(body.useTwinPreferences) }),
    })
    ctx.status = 201; return { constraint: publicConstraint(snapshot) }
  })
}

/** @openapi-response LifePlanListResponse */
export async function plans(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['state', 'limit']))
    const state = queryEnum(ctx, 'state', ['proposed', 'reserved', 'superseded', 'completed', 'expired'] as const)
    return { plans: listLifePlanRevisions({ ...(state ? { state } : {}), limit: queryLimit(ctx) }).map(publicPlan) } })
}

/** @openapi-response LifePlanResponse */
export async function createPlan(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = exactBody(ctx, new Set(['constraintSnapshotId', 'activeAt', 'maxOptions', 'maxSessions']))
    const result = planLifeLeisure({ constraintSnapshotId: requiredId(body.constraintSnapshotId),
      activeAt: requiredTimestamp(body.activeAt),
      ...(body.maxOptions === undefined ? {} : { maxOptions: requiredInteger(body.maxOptions, 1, 64) }),
      ...(body.maxSessions === undefined ? {} : { maxSessions: requiredInteger(body.maxSessions, 1, 32) }) })
    reconcileLifeRuntime(); ctx.status = 201
    return { plan: publicPlan(result.plan), handoffs: result.handoffs.map(publicHandoff) }
  })
}

/** @openapi-response LifeActionResponse */
export async function verifyPlan(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = actionBody(ctx, new Set(['planRevisionId', 'activeAt']))
    const plan = requiredPlan(requiredId(body.planRevisionId)); reconcileLifeRuntime()
    return accepted(ctx, lifeIntent(ctx, null, LIFE_PLAN_VERIFY_CAPABILITY,
      { schemaVersion: 1, planRevisionId: plan.id, planDigest: plan.planDigest,
        constraintSnapshotId: plan.constraintSnapshotId, constraintDigest: plan.constraintDigest,
        currency: plan.totalCost.currency, activeAt: requiredTimestamp(body.activeAt) },
      { kind: 'life_plan', planDigest: plan.planDigest, currency: plan.totalCost.currency }, body,
      'Verify one immutable leisure plan revision'))
  })
}

/** @openapi-response LifeHandoffListResponse */
export async function handoffs(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['planRevisionId', 'limit']))
    return { handoffs: listLifeHandoffs(queryId(ctx, 'planRevisionId'), queryLimit(ctx)).map(publicHandoff) } })
}

/** @openapi-response LifeActionResponse */
export async function createCalendarHold(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = actionBody(ctx, new Set(['accountId', 'planRevisionId', 'optionId', 'providerRequestId']))
    const account = requiredAccount(requiredId(body.accountId)); const plan = requiredPlan(requiredId(body.planRevisionId))
    const optionId = requiredId(body.optionId); const session = plan.sessions.find(item => item.optionId === optionId)
    if (!session || account.sourceKind !== 'calendar') throw coded('LIFE_CALENDAR_HOLD_MATERIAL_MISMATCH')
    reconcileLifeRuntime()
    return accepted(ctx, lifeIntent(ctx, account, LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
      { schemaVersion: 1, accountId: account.id, planRevisionId: plan.id, planDigest: plan.planDigest,
        providerRequestId: requiredToken(body.providerRequestId), currency: plan.totalCost.currency,
        optionId, startsAt: session.startsAt, endsAt: session.endsAt },
      calendarTarget(account, plan.planDigest, plan.totalCost.currency), body,
      'Create one exact calendar hold for a current plan session'))
  })
}

/** @openapi-response LifeCalendarHoldListResponse */
export async function holds(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['accountId', 'state', 'limit']))
    const accountId = queryId(ctx, 'accountId'); const state = queryEnum(ctx, 'state',
      ['requested', 'submitting', 'confirmed', 'cancel_requested', 'cancelling', 'cancelled',
        'lookup_required', 'waiting_user', 'failed'] as const)
    return { holds: listLifeCalendarHolds({ ...(accountId ? { accountId } : {}),
      ...(state ? { state } : {}), limit: queryLimit(ctx) }).map(publicHold) } })
}

/** @openapi-response LifeActionResponse */
export async function cancelCalendarHold(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = actionBody(ctx, new Set(['holdId', 'providerRequestId', 'reasonCode']))
    const hold = requiredHold(requiredId(body.holdId)); const account = requiredAccount(hold.accountId)
    const plan = requiredPlan(hold.planRevisionId)
    if (!hold.providerHoldId) throw coded('LIFE_CALENDAR_HOLD_MATERIAL_MISMATCH')
    reconcileLifeRuntime()
    return accepted(ctx, lifeIntent(ctx, account, LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
      { schemaVersion: 1, accountId: account.id, planRevisionId: plan.id, planDigest: hold.planDigest,
        providerRequestId: requiredToken(body.providerRequestId), currency: plan.totalCost.currency,
        holdId: hold.id, expectedVersion: hold.version, providerHoldId: hold.providerHoldId,
        reasonCode: requiredErrorCode(body.reasonCode) },
      calendarTarget(account, hold.planDigest, plan.totalCost.currency), body, 'Cancel one exact calendar hold'))
  })
}

/** @openapi-response LifeActionResponse */
export async function cancelSubscription(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx); const body = actionBody(ctx, new Set(['subscriptionId', 'providerRequestId', 'reasonCode']))
    const subscription = requiredSubscription(requiredId(body.subscriptionId))
    const account = requiredAccount(subscription.accountId); reconcileLifeRuntime()
    return accepted(ctx, lifeIntent(ctx, account, LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
      { schemaVersion: 1, accountId: account.id, subscriptionId: subscription.id,
        subscriptionDigest: lifeSubscriptionMaterialDigest(subscription),
        providerRequestId: requiredToken(body.providerRequestId), reasonCode: requiredErrorCode(body.reasonCode),
        currency: subscription.recurringCost.currency },
      { kind: 'life_subscription', accountId: account.id, subscriptionId: subscription.id,
        currency: subscription.recurringCost.currency }, body, 'Cancel one exact eligible subscription'))
  })
}

/** @openapi-response LifeCancellationListResponse */
export async function cancellations(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['accountId', 'state', 'limit']))
    const accountId = queryId(ctx, 'accountId'); const state = queryEnum(ctx, 'state',
      ['requested', 'submitting', 'processing', 'cancelled', 'rejected', 'lookup_required',
        'waiting_user', 'failed'] as const)
    return { cancellations: listLifeSubscriptionCancellations({ ...(accountId ? { accountId } : {}),
      ...(state ? { state } : {}), limit: queryLimit(ctx) }).map(publicCancellation) } })
}

/** @openapi-response LifeWorkflowListResponse */
export async function workflows(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['state', 'limit']))
    const state = queryEnum(ctx, 'state', ['draft', 'policy_check', 'preparing', 'executing', 'verifying',
      'waiting_user', 'retrying', 'compensating', 'succeeded', 'denied', 'cancelled', 'failed',
      'dead_letter', 'compensated'] as const)
    return { workflows: lifeWorkflows(queryLimit(ctx), state).map(publicWorkflow) } })
}

/** @openapi-response LifeWorkflowResponse */
export async function workflow(ctx: Context): Promise<void> {
  respond(ctx, () => { noQuery(ctx); const result = getFabricWorkflow(pathId(ctx))
    if (!result || !CAPABILITIES.has(result.capabilityId) || result.requestedByRoleId !== LIFE_ASSISTANT_ROLE_ID) {
      throw coded('LIFE_WORKFLOW_NOT_FOUND')
    }
    return { workflow: publicWorkflowDetail(result) } })
}

/** @openapi-response LifeTakeoverListResponse */
export async function takeovers(ctx: Context): Promise<void> {
  respond(ctx, () => { queryKeys(ctx, new Set(['limit'])); return {
    takeovers: lifeWorkflows(queryLimit(ctx), 'waiting_user').map(publicTakeover) } })
}

function lifeIntent(ctx: Context, account: LifeSourceAccount | null, capabilityId: string,
  input: Record<string, unknown>, target: Record<string, unknown>, body: Record<string, unknown>, goal: string) {
  return createFabricIntent({ capabilityId, requestedByRoleId: LIFE_ASSISTANT_ROLE_ID,
    requestedByUserId: actorUserId(ctx), idempotencyKey: requiredToken(body.idempotencyKey), goal,
    target, input, constraints: {}, rationale: requiredText(body.rationale, 500),
    environments: account ? account.mode === 'shadow' ? ['sandbox'] : ['production'] : ['sandbox', 'production'] })
}
function accepted(ctx: Context, result: FabricIntentResult) { ctx.status = 202; return publicAction(result) }
function lifeWorkflows(limit: number, state?: FabricWorkflowSummary['state']) {
  return listFabricWorkflows({ requestedByRoleId: LIFE_ASSISTANT_ROLE_ID, ...(state ? { state } : {}), limit: MAX_LIST })
    .filter(item => CAPABILITIES.has(item.capabilityId)).slice(0, limit)
}
function calendarTarget(account: LifeSourceAccount, planDigest: string, currency: string) {
  return { kind: 'life_calendar', accountId: account.id, calendarId: account.id, planDigest, currency }
}

function publicAction(result: FabricIntentResult) { return { intent: { id: result.intent.id,
  capabilityId: result.intent.capabilityId }, policyDecision: { id: result.policyDecision.id,
  outcome: result.policyDecision.outcome, reasonCodes: [...result.policyDecision.reasonCodes] },
  workflow: publicWorkflow(result.workflow) } }
function publicWorkflow(item: FabricWorkflowSummary) { return { id: item.id, capabilityId: item.capabilityId,
  state: item.state, version: item.version, attempt: item.attempt, lastErrorCode: item.lastErrorCode,
  createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt,
  availableActions: { ...item.availableActions } } }
function publicWorkflowDetail(item: FabricWorkflowDetail) { return { ...publicWorkflow(item),
  policyDecision: item.policyDecision ? { id: item.policyDecision.id, outcome: item.policyDecision.outcome,
    reasonCodes: [...item.policyDecision.reasonCodes] } : null,
  steps: item.steps.slice(0, 32).map(step => ({ kind: step.kind, state: step.state, attempt: step.attempt,
    lastErrorCode: step.lastErrorCode, updatedAt: step.updatedAt })) } }
function publicTakeover(item: FabricWorkflowSummary) { return { workflowId: item.id, capabilityId: item.capabilityId,
  reasonCode: item.lastErrorCode ?? 'USER_APPROVAL_REQUIRED', state: item.state, requestedAt: item.updatedAt } }
function publicAccount(item: LifeSourceAccount) { return { id: item.id, sourceKind: item.sourceKind, mode: item.mode,
  executorId: item.executorId, displayName: publicText(item.displayName), health: item.health, enabled: item.enabled,
  policyEpoch: item.policyEpoch, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt,
  revokedAt: item.revokedAt } }
function publicCommitment(item: ReturnType<typeof listLifeCommitments>[number]) { return { id: item.id,
  accountId: item.accountId, label: publicText(item.label), category: item.category, startsAt: item.startsAt,
  endsAt: item.endsAt, allDay: item.allDay, busy: item.busy, locationClass: item.locationClass,
  participantAliasIds: [...item.participantAliasIds], observedAt: item.observedAt,
  expiresAt: item.expiresAt, sourceDigest: item.sourceDigest } }
function publicContact(item: ReturnType<typeof listLifeContactAliases>[number]) { return { id: item.id,
  accountId: item.accountId, alias: publicText(item.alias), relationshipTags: [...item.relationshipTags],
  availabilityTags: [...item.availabilityTags], observedAt: item.observedAt, sourceDigest: item.sourceDigest } }
function publicOption(item: ReturnType<typeof listLifeOptions>[number]) { return { id: item.id,
  accountId: item.accountId, kind: item.kind, source: publicText(item.source), title: publicText(item.title),
  categoryTags: [...item.categoryTags], durationMinutes: item.durationMinutes, exertion: item.exertion,
  screenBased: item.screenBased, locationClass: item.locationClass, cost: item.cost ? { ...item.cost } : null,
  available: item.available, observedAt: item.observedAt, expiresAt: item.expiresAt,
  sourceDigest: item.sourceDigest } }
function publicSubscription(item: ReturnType<typeof listLifeSubscriptions>[number]) { return { id: item.id,
  accountId: item.accountId, serviceLabel: publicText(item.serviceLabel), planLabel: publicText(item.planLabel),
  recurringCost: { ...item.recurringCost }, renewalAt: item.renewalAt,
  cancellationDeadline: item.cancellationDeadline, state: item.state, observedAt: item.observedAt,
  sourceDigest: item.sourceDigest, version: item.version } }
function publicConstraint(item: NonNullable<ReturnType<typeof getLifeConstraintSnapshot>>) { return { ...item,
  horizon: { ...item.horizon }, freeWindows: item.freeWindows.map(value => ({ ...value })),
  commitmentIds: [...item.commitmentIds], budget: { ...item.budget },
  excludedCategories: [...item.excludedCategories], preferredCategories: [...item.preferredCategories],
  factRefs: item.factRefs.map(value => ({ ...value })) } }
function publicPlan(item: NonNullable<ReturnType<typeof getLifePlanRevision>>) { return { ...item,
  candidates: item.candidates.map(value => ({ ...value, exclusionCodes: [...value.exclusionCodes],
    rationaleCodes: [...value.rationaleCodes] })), sessions: item.sessions.map(value => ({ ...value,
      cost: value.cost ? { ...value.cost } : null, rationaleCodes: [...value.rationaleCodes] })),
  totalCost: { ...item.totalCost } } }
function publicHandoff(item: ReturnType<typeof listLifeHandoffs>[number]) { return { ...item } }
function publicHold(item: ReturnType<typeof listLifeCalendarHolds>[number]) { return { id: item.id,
  workflowId: item.workflowId, accountId: item.accountId, planRevisionId: item.planRevisionId,
  planDigest: item.planDigest, optionId: item.optionId, window: { ...item.window },
  receiptDigest: item.receiptDigest, state: item.state, policyEpoch: item.policyEpoch, version: item.version,
  createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt } }
function publicCancellation(item: ReturnType<typeof listLifeSubscriptionCancellations>[number]) { return { id: item.id,
  workflowId: item.workflowId, accountId: item.accountId, subscriptionId: item.subscriptionId,
  subscriptionDigest: item.subscriptionDigest, reasonCode: item.reasonCode, receiptDigest: item.receiptDigest,
  state: item.state, policyEpoch: item.policyEpoch, version: item.version, createdAt: item.createdAt,
  updatedAt: item.updatedAt, completedAt: item.completedAt } }

function actionBody(ctx: Context, fields: ReadonlySet<string>) {
  return exactBody(ctx, new Set([...fields, 'idempotencyKey', 'rationale']))
}
function exactBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') throw new LifeRequestError('JSON required')
  assertJson(request.body, 0, new WeakSet())
  if (!plainRecord(request.body) || Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_BODY_BYTES) {
    throw new LifeRequestError('Invalid body')
  }
  for (const key of Object.keys(request.body)) if (!allowed.has(key)) throw new LifeRequestError('Unexpected field')
  return request.body
}
function assertJson(value: unknown, depth: number, ancestors: WeakSet<object>): void {
  if (depth > 8) throw new LifeRequestError('JSON too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new LifeRequestError('Invalid JSON')
  ancestors.add(value)
  try {
    if (Array.isArray(value) && !isProxy(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) throw new LifeRequestError('Invalid array')
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new LifeRequestError('Accessor forbidden')
        assertJson(descriptor.value, depth + 1, ancestors)
      }
      return
    }
    if (!plainRecord(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string')
      || Object.keys(value).length > 64) throw new LifeRequestError('Invalid object')
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new LifeRequestError('Unsafe key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new LifeRequestError('Accessor forbidden')
      assertJson(descriptor.value, depth + 1, ancestors)
    }
  } finally { ancestors.delete(value) }
}
function plainRecord(value: unknown): value is Record<string, unknown> { if (!value || typeof value !== 'object'
  || Array.isArray(value) || isProxy(value)) return false; const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null }
function timeWindow(value: unknown) { if (!plainRecord(value) || !exactKeys(value, ['startsAt', 'endsAt']))
  throw new LifeRequestError('Invalid window'); return { startsAt: requiredTimestamp(value.startsAt),
    endsAt: requiredTimestamp(value.endsAt) } }
function constraintPolicy(value: unknown) { if (!plainRecord(value) || !exactKeys(value, ['budget',
  'screenTimeLimitMinutes', 'leisureTimeLimitMinutes', 'quietStartMinute', 'quietEndMinute', 'maxTravelRadiusKm',
  'excludedCategories', 'preferredCategories'])) throw new LifeRequestError('Invalid policy')
  if (!plainRecord(value.budget) || !exactKeys(value.budget, ['currency', 'amountMinor']))
    throw new LifeRequestError('Invalid budget')
  return { budget: { currency: requiredCurrency(value.budget.currency),
    amountMinor: requiredInteger(value.budget.amountMinor, 0, Number.MAX_SAFE_INTEGER) },
  screenTimeLimitMinutes: requiredInteger(value.screenTimeLimitMinutes, 0, 10_080),
  leisureTimeLimitMinutes: requiredInteger(value.leisureTimeLimitMinutes, 0, 10_080),
  quietStartMinute: requiredInteger(value.quietStartMinute, 0, 1_439),
  quietEndMinute: requiredInteger(value.quietEndMinute, 0, 1_439),
  maxTravelRadiusKm: requiredInteger(value.maxTravelRadiusKm, 0, 100_000),
  excludedCategories: idArray(value.excludedCategories, 64), preferredCategories: idArray(value.preferredCategories, 64) } }
function activationLimits(value: unknown): LifeActivationLimits { if (!plainRecord(value)
  || !exactKeys(value, ['currency', 'calendarIds', 'subscriptionIds'])) throw new LifeRequestError('Invalid limits')
  return { currency: requiredCurrency(value.currency), calendarIds: idArray(value.calendarIds, 30),
    subscriptionIds: idArray(value.subscriptionIds, 30) } }
function requiredAccount(id: string) { const item = getLifeSourceAccount(id); if (!item) throw coded('LIFE_ACCOUNT_NOT_FOUND'); return item }
function requiredPlan(id: string) { const item = getLifePlanRevision(id); if (!item) throw coded('LIFE_PLAN_NOT_FOUND'); return item }
function requiredHold(id: string) { const item = getLifeCalendarHold(id); if (!item) throw coded('LIFE_CALENDAR_HOLD_NOT_FOUND'); return item }
function requiredSubscription(id: string) { const item = getLifeSubscription(id); if (!item) throw coded('LIFE_SUBSCRIPTION_NOT_FOUND'); return item }
function requiredId(value: unknown) { if (typeof value !== 'string' || !ID.test(value)) throw new LifeRequestError('Invalid identifier'); return value }
function requiredToken(value: unknown) { if (typeof value !== 'string' || !TOKEN.test(value)
  || isFabricSensitiveString(value)) throw new LifeRequestError('Invalid token'); return value }
function requiredCursor(value: unknown) { if (typeof value !== 'string' || !/^offset-(0|[1-9][0-9]*)$/.test(value))
  throw new LifeRequestError('Invalid cursor'); return value }
function requiredCurrency(value: unknown) { if (typeof value !== 'string' || !CURRENCY.test(value)) throw new LifeRequestError('Invalid currency'); return value }
function requiredErrorCode(value: unknown) { if (typeof value !== 'string' || !ERROR_CODE.test(value)) throw new LifeRequestError('Invalid reason'); return value }
function requiredText(value: unknown, max: number) { if (typeof value !== 'string' || value.trim() !== value
  || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value) || isFabricSensitiveString(value))
  throw new LifeRequestError('Invalid text'); return value }
function requiredInteger(value: unknown, min: number, max: number) { if (!Number.isSafeInteger(value)
  || Number(value) < min || Number(value) > max) throw new LifeRequestError('Invalid integer'); return Number(value) }
function requiredBoolean(value: unknown) { if (typeof value !== 'boolean') throw new LifeRequestError('Invalid boolean'); return value }
function optionalBoolean(value: unknown) { return value === undefined ? undefined : requiredBoolean(value) }
function requiredEnum<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string'
  || !values.includes(value as T)) throw new LifeRequestError('Invalid enum'); return value as T }
function requiredTimestamp(value: unknown) { if (typeof value !== 'string' || !validTimestamp(value))
  throw new LifeRequestError('Invalid timestamp'); return value }
function idArray(value: unknown, max: number) { if (!Array.isArray(value) || value.length > max)
  throw new LifeRequestError('Invalid array'); const result = value.map(requiredId)
  if (new Set(result).size !== result.length) throw new LifeRequestError('Duplicate item'); return result }
function exactKeys(value: Record<string, unknown>, wanted: string[]) { const keys = Object.keys(value).sort()
  const expected = [...wanted].sort(); return keys.length === expected.length && keys.every((key, i) => key === expected[i]) }
function validTimestamp(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed)
  && new Date(parsed).toISOString() === value }
function publicText(value: string) { return isFabricSensitiveString(value) ? '[REDACTED]' : value }
function noQuery(ctx: Context) { queryKeys(ctx, new Set()) }
function queryKeys(ctx: Context, allowed: ReadonlySet<string>) { if (!plainRecord(ctx.query)) throw new LifeRequestError('Invalid query')
  for (const key of Reflect.ownKeys(ctx.query)) if (typeof key !== 'string' || !allowed.has(key)
    || typeof Object.getOwnPropertyDescriptor(ctx.query, key)?.value !== 'string') throw new LifeRequestError('Invalid query') }
function queryRaw(ctx: Context, key: string) { const value = ctx.query[key]; if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new LifeRequestError('Invalid query'); return value }
function queryId(ctx: Context, key: string) { const value = queryRaw(ctx, key); return value === undefined ? undefined : requiredId(value) }
function queryTimestamp(ctx: Context, key: string) { const value = queryRaw(ctx, key); return value === undefined ? undefined : requiredTimestamp(value) }
function queryEnum<T extends string>(ctx: Context, key: string, values: readonly T[]) { const value = queryRaw(ctx, key)
  return value === undefined ? undefined : requiredEnum(value, values) }
function queryLimit(ctx: Context) { const value = queryRaw(ctx, 'limit'); if (value === undefined) return 100
  if (!/^[1-9]\d*$/.test(value)) throw new LifeRequestError('Invalid limit'); return requiredInteger(Number(value), 1, MAX_LIST) }
function pathId(ctx: Context) { const value = typeof ctx.params.id === 'string' ? ctx.params.id : ''
  try { return requiredId(decodeURIComponent(value)) } catch (error) { if (error instanceof LifeRequestError) throw error
    throw new LifeRequestError('Invalid path') } }
function actorUserId(ctx: Context) { const raw = ctx.state.user?.id; const value = typeof raw === 'number' ? String(raw) : raw
  if (typeof value !== 'string' || !ID.test(value)) throw coded('LIFE_ACTOR_UNAVAILABLE'); return value }
function terminalWorkflow(state: string) { return ['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated'].includes(state) }
function coded(code: string) { return new Error(code) }
function respond(ctx: Context, operation: () => unknown) { try { ctx.body = operation() } catch (error) { mapError(ctx, error) } }
function mapError(ctx: Context, error: unknown) {
  const code = error instanceof LifeContractError || error instanceof Error && /^LIFE_[A-Z0-9_]+$/.test(error.message)
    ? error.message : error instanceof LifeRequestError ? 'LIFE_REQUEST_INVALID' : 'LIFE_INTERNAL_ERROR'
  const status = code === 'LIFE_ACTOR_UNAVAILABLE' ? 403 : code.endsWith('_NOT_FOUND') ? 404
    : code.includes('VERSION_CONFLICT') || code.includes('REPLAY_MISMATCH') || code.includes('SUBSTITUTION')
      || code.includes('OWNED_BY_OTHER') ? 409
      : code.includes('UNAVAILABLE') || code === 'LIFE_INTERNAL_ERROR' ? 503
        : code.includes('REQUIRED') || code.includes('FORBIDDEN') || code.includes('GATE_FAILED')
          || code.includes('STALE') ? 422 : 400
  ctx.status = status; ctx.body = { error: status === 404 ? 'Life resource not found'
    : status === 409 ? 'Life state changed' : status === 503 ? 'Life service unavailable'
      : status === 403 ? 'Authenticated actor unavailable' : 'Invalid life request', code }
}
