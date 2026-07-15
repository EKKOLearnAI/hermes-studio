import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Context } from 'koa'
import {
  createFabricIntent,
  getFabricWorkflow,
  listFabricExecutors,
  listFabricWorkflows,
  type FabricWorkflowDetail,
} from '../../services/hermes/action-fabric'
import type { FabricJsonObject } from '../../services/hermes/action-fabric/types'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_ORIGIN,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
  ENTERTAINMENT_ASSISTANT_ROLE_ID,
  INTERNET_RECEIPT_STATUSES,
  InternetExecutionIdentityConflictError,
  InternetExecutionNotFoundError,
  InternetExecutionStore,
  InternetExecutionValidationError,
  InternetExecutionVersionConflictError,
  isBilibiliBvid,
  isInternetCapability,
  validateInternetOutputSemantics,
  validateInternetSemantics,
  withInternetExecutionDb,
  type InternetExecutionCheckpoint,
  type InternetExecutionReceipt,
} from '../../services/hermes/internet-execution'
import {
  BILIBILI_BROWSER_EXECUTOR_ID,
  BILIBILI_MCP_EXECUTOR_ID,
  getInternetProductionRuntimeStatus,
  reconcileInternetProductionRuntime,
} from '../../services/hermes/internet-execution/production-runtime'

class InternetApiRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const PROFILE = /^[^/\\\u0000-\u001f\u007f]{1,200}$/
const MAX_BODY_BYTES = 16_384
const TERMINAL_WORKFLOW_STATES = new Set([
  'succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated',
])

/** @openapi-default-errors 400:InternetApiError,401:AuthError,403:AuthError,404:InternetApiError,409:InternetApiError,500:InternetApiError,503:InternetApiError */

/** @openapi-response InternetOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const runtime = getInternetProductionRuntimeStatus()
    const registry = listFabricExecutors()
    const receipts = withReceiptStore(store => store.listReceipts({
      provider: BILIBILI_PROVIDER, profile: runtime.profile, limit: 200,
    }))
    const workflows = listFabricWorkflows({ requestedByRoleId: ENTERTAINMENT_ASSISTANT_ROLE_ID, limit: 200 })
    return {
      provider: publicProvider(runtime),
      executors: [
        publicExecutor('mcp', BILIBILI_MCP_EXECUTOR_ID, runtime.selectedExecutorId, registry),
        publicExecutor('browser', BILIBILI_BROWSER_EXECUTOR_ID, runtime.selectedExecutorId, registry),
      ],
      capabilities: [BILIBILI_SEARCH_CAPABILITY, BILIBILI_INSPECT_CAPABILITY].map(id => ({
        id, provider: BILIBILI_PROVIDER, available: runtime.executorEnabled,
      })),
      summary: {
        receiptCount: receipts.length,
        verifiedReceiptCount: receipts.filter(receipt => receipt.status === 'verified').length,
        waitingUserReceiptCount: receipts.filter(receipt => receipt.status === 'waiting_user').length,
        activeWorkflowCount: workflows.filter(workflow => !TERMINAL_WORKFLOW_STATES.has(workflow.state)).length,
      },
    }
  })
}

/** @openapi-response InternetActionResponse */
export async function searchBilibili(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['query', 'limit', 'page', 'order', 'idempotencyKey']))
    const input = {
      query: requiredText(body.query, 120),
      limit: optionalInteger(body.limit, 1, 20) ?? 10,
      page: optionalInteger(body.page, 1, 10) ?? 1,
      order: optionalEnum(body.order, ['relevance', 'newest', 'most_viewed'] as const) ?? 'relevance',
    }
    const result = await createInternetIntent(ctx, BILIBILI_SEARCH_CAPABILITY, input,
      requiredId(body.idempotencyKey))
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response InternetActionResponse */
export async function inspectBilibili(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['bvid', 'idempotencyKey']))
    if (!isBilibiliBvid(body.bvid)) throw new InternetApiRequestError('Invalid BVID')
    const result = await createInternetIntent(ctx, BILIBILI_INSPECT_CAPABILITY, { bvid: body.bvid },
      requiredId(body.idempotencyKey))
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response InternetReceiptListResponse */
export async function receipts(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['status', 'limit']))
    const status = queryEnum(ctx, 'status', INTERNET_RECEIPT_STATUSES)
    const limit = queryInteger(ctx, 'limit', 1, 200) ?? 100
    const profile = serverProfile()
    const values = withReceiptStore(store => store.listReceipts({
      provider: BILIBILI_PROVIDER, profile, ...(status ? { status } : {}), limit: 200,
    }))
      .filter(receipt => canReadWorkflow(ctx, receipt.workflowId))
      .slice(0, limit)
      .map(publicReceipt)
    return { receipts: values }
  })
}

/** @openapi-response InternetReceiptResponse */
export async function receipt(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const workflowId = pathId(ctx, 'workflowId')
    requireInternetWorkflow(ctx, workflowId)
    const value = withReceiptStore(store => store.getReceipt(workflowId))
    if (!value || value.provider !== BILIBILI_PROVIDER || !isInternetCapability(value.capabilityId)) {
      throw coded('INTERNET_RECEIPT_NOT_FOUND')
    }
    const evidence = withReceiptStore(store => store.listCheckpoints(workflowId)).map(publicEvidence)
    return { receipt: publicReceipt(value), evidence }
  })
}

/** @openapi-response InternetWorkflowResponse */
export async function workflow(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    return { workflow: publicWorkflow(requireInternetWorkflow(ctx, pathId(ctx, 'workflowId'))) }
  })
}

async function createInternetIntent(
  ctx: Context,
  capabilityId: typeof BILIBILI_SEARCH_CAPABILITY | typeof BILIBILI_INSPECT_CAPABILITY,
  semanticInput: Record<string, unknown>,
  idempotencyKey: string,
) {
  await reconcileInternetProductionRuntime()
  const profile = serverProfile()
  const runtime = getInternetProductionRuntimeStatus()
  if (!runtime.active || runtime.profile !== profile) throw coded('INTERNET_RUNTIME_PROFILE_STALE')
  const input = { schemaVersion: 1, provider: BILIBILI_PROVIDER, profile, ...semanticInput }
  const target = { kind: 'internet_provider', provider: BILIBILI_PROVIDER, origin: BILIBILI_ORIGIN, profile }
  if (!validateInternetSemantics(capabilityId, input)) throw new InternetApiRequestError('Invalid semantic input')
  return createFabricIntent({
    capabilityId,
    requestedByRoleId: ENTERTAINMENT_ASSISTANT_ROLE_ID,
    requestedByUserId: actorUserId(ctx),
    idempotencyKey,
    goal: capabilityId === BILIBILI_SEARCH_CAPABILITY
      ? 'Search public Bilibili videos' : 'Inspect one public Bilibili video',
    target,
    input,
    constraints: {},
    rationale: 'Explicit authenticated semantic internet read',
    environments: ['production'],
  })
}

function publicProvider(runtime: ReturnType<typeof getInternetProductionRuntimeStatus>) {
  return {
    provider: BILIBILI_PROVIDER,
    profile: runtime.profile,
    active: runtime.active,
    configured: runtime.configured,
    discoveryStatus: runtime.discoveryStatus,
    executorEnabled: runtime.executorEnabled,
    selectedExecutorType: runtime.selectedExecutorId === BILIBILI_MCP_EXECUTOR_ID ? 'mcp'
      : runtime.selectedExecutorId === BILIBILI_BROWSER_EXECUTOR_ID ? 'browser' : null,
    authorizedTargetCount: runtime.authorizedTargetCount,
    lastErrorCode: runtime.lastErrorCode,
  }
}

function publicExecutor(
  type: 'mcp' | 'browser',
  id: string,
  selectedId: string | null,
  registry: ReturnType<typeof listFabricExecutors>,
) {
  const executor = registry.find(item => item.id === id)
  return {
    type,
    environment: 'production',
    enabled: executor?.enabled === true,
    health: executor?.health ?? 'unknown',
    selected: selectedId === id,
  }
}

function publicAction(result: ReturnType<typeof createFabricIntent>) {
  return {
    intent: { id: result.intent.id, capabilityId: result.intent.capabilityId },
    policyDecision: {
      id: result.policyDecision.id,
      outcome: result.policyDecision.outcome,
      reasonCodes: [...result.policyDecision.reasonCodes],
    },
    workflow: publicWorkflowBase(result.workflow),
  }
}

function publicWorkflow(value: FabricWorkflowDetail) {
  return {
    ...publicWorkflowBase(value),
    capabilityId: value.capabilityId,
    policyDecision: value.policyDecision ? {
      id: value.policyDecision.id,
      outcome: value.policyDecision.outcome,
      reasonCodes: [...value.policyDecision.reasonCodes],
    } : null,
    steps: value.steps.map(step => ({
      kind: step.kind,
      state: step.state,
      attempt: step.attempt,
      lastErrorCode: step.lastErrorCode,
      updatedAt: step.updatedAt,
    })),
  }
}

function publicWorkflowBase(value: ReturnType<typeof createFabricIntent>['workflow'] | FabricWorkflowDetail) {
  return {
    id: value.id,
    state: value.state,
    version: value.version,
    attempt: value.attempt,
    lastErrorCode: value.lastErrorCode,
    availableActions: { ...value.availableActions },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function publicReceipt(value: InternetExecutionReceipt) {
  const result = publicResult(value)
  return {
    workflowId: value.workflowId,
    intentId: value.intentId,
    capabilityId: value.capabilityId,
    provider: value.provider,
    profile: value.profile,
    executorType: value.executorType,
    environment: value.environment,
    operation: value.operation,
    input: publicSemanticInput(value),
    safeToReplay: value.safeToReplay,
    status: value.status,
    result,
    resultDigest: result === null ? null : createHash('sha256').update(stableJson(result)).digest('hex'),
    errorCode: value.errorCode,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function publicSemanticInput(value: InternetExecutionReceipt): Record<string, unknown> {
  if (!validateInternetSemantics(value.capabilityId, value.request as FabricJsonObject)) return {}
  if (value.capabilityId === BILIBILI_SEARCH_CAPABILITY) {
    return {
      query: value.request.query,
      limit: value.request.limit,
      page: value.request.page,
      order: value.request.order,
    }
  }
  return { bvid: value.request.bvid }
}

function publicResult(value: InternetExecutionReceipt): Record<string, unknown> | null {
  if (!value.result || !validateInternetOutputSemantics(
    value.capabilityId,
    value.request as FabricJsonObject,
    value.result as FabricJsonObject,
  )) return null
  return JSON.parse(JSON.stringify(value.result)) as Record<string, unknown>
}

function publicEvidence(value: InternetExecutionCheckpoint) {
  const stages: Record<InternetExecutionCheckpoint['kind'], string> = {
    mcp_call: 'provider_read',
    browser_navigate: 'navigation',
    browser_snapshot: 'snapshot',
    verification_read: 'verification',
  }
  return {
    ordinal: value.ordinal,
    stage: stages[value.kind],
    evidenceDigest: value.evidenceDigest,
    observedAt: value.observedAt,
  }
}

function requireInternetWorkflow(ctx: Context, id: string): FabricWorkflowDetail {
  const value = getFabricWorkflow(id)
  if (!value || !isInternetCapability(value.capabilityId)
    || value.requestedByRoleId !== ENTERTAINMENT_ASSISTANT_ROLE_ID) {
    throw coded('INTERNET_WORKFLOW_NOT_FOUND')
  }
  if (ctx.state.user?.role !== 'super_admin' && value.requestedByUserId !== actorUserId(ctx)) {
    throw coded('INTERNET_WORKFLOW_NOT_FOUND')
  }
  return value
}

function canReadWorkflow(ctx: Context, id: string): boolean {
  const value = getFabricWorkflow(id)
  if (!value || !isInternetCapability(value.capabilityId)
    || value.requestedByRoleId !== ENTERTAINMENT_ASSISTANT_ROLE_ID) return false
  return ctx.state.user?.role === 'super_admin' || value.requestedByUserId === actorUserId(ctx)
}

function withReceiptStore<T>(operation: (store: InternetExecutionStore) => T): T {
  return withInternetExecutionDb<T>(db => operation(new InternetExecutionStore(db)) as
    T & (T extends PromiseLike<unknown> ? never : unknown))
}

async function respond(ctx: Context, operation: () => unknown | Promise<unknown>): Promise<void> {
  try { ctx.body = await operation() } catch (error) { mapError(ctx, error) }
}

function mapError(ctx: Context, error: unknown): void {
  if (error instanceof InternetApiRequestError || error instanceof InternetExecutionValidationError) {
    ctx.status = 400
    ctx.body = { error: 'Invalid internet request', code: 'INTERNET_REQUEST_INVALID' }
    return
  }
  if (error instanceof InternetExecutionNotFoundError) {
    ctx.status = 404
    ctx.body = { error: 'Internet record not found', code: 'INTERNET_RECORD_NOT_FOUND' }
    return
  }
  if (error instanceof InternetExecutionIdentityConflictError || error instanceof InternetExecutionVersionConflictError) {
    ctx.status = 409
    ctx.body = { error: 'Internet state conflict', code: 'INTERNET_STATE_CONFLICT' }
    return
  }
  const raw = error instanceof Error ? error.message : ''
  const code = /^INTERNET_(?:WORKFLOW|RECEIPT)_NOT_FOUND$/.test(raw) ? raw
    : raw === 'INTERNET_RUNTIME_PROFILE_STALE' ? raw : 'INTERNET_API_OPERATION_FAILED'
  ctx.status = code.endsWith('_NOT_FOUND') ? 404 : 503
  ctx.body = { error: 'Internet operation failed', code }
}

function exactBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') {
    throw new InternetApiRequestError('JSON required')
  }
  assertPlainJson(request.body)
  if (!plain(request.body) || Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_BODY_BYTES) {
    throw new InternetApiRequestError('Invalid JSON body')
  }
  if (Object.keys(request.body).some(key => !allowed.has(key))) {
    throw new InternetApiRequestError('Unexpected request field')
  }
  return request.body
}

function assertPlainJson(value: unknown, depth = 0, counter = { value: 0 }): void {
  counter.value += 1
  if (counter.value > 128 || depth > 4) throw new InternetApiRequestError('JSON body is too complex')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.length > 2_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new InternetApiRequestError('Invalid string')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InternetApiRequestError('Invalid number')
    return
  }
  if (!plain(value)) throw new InternetApiRequestError('Invalid JSON value')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new InternetApiRequestError('Invalid JSON key')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new InternetApiRequestError('Invalid JSON property')
    assertPlainJson(descriptor.value, depth + 1, counter)
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new InternetApiRequestError('Invalid identifier')
  return value
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new InternetApiRequestError('Invalid text')
  return value
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new InternetApiRequestError('Invalid integer')
  }
  return Number(value)
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new InternetApiRequestError('Invalid enum')
  return value as T
}

function actorUserId(ctx: Context): string {
  const value = ctx.state.user?.id
  if ((typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) && typeof value !== 'string') {
    throw coded('INTERNET_ACTOR_UNAVAILABLE')
  }
  return requiredId(String(value))
}

function serverProfile(): string {
  const value = getActiveProfileName()
  if (!PROFILE.test(value) || value.trim() !== value) throw coded('INTERNET_ACTIVE_PROFILE_INVALID')
  return value
}

function pathId(ctx: Context, key: string): string {
  let value = String(ctx.params[key] ?? '')
  try { value = decodeURIComponent(value) } catch { throw new InternetApiRequestError('Invalid path identifier') }
  return requiredId(value)
}

function noQuery(ctx: Context): void { queryKeys(ctx, new Set()) }

function queryKeys(ctx: Context, allowed: ReadonlySet<string>): void {
  if (!plain(ctx.query) || Object.keys(ctx.query).some(key => !allowed.has(key))) {
    throw new InternetApiRequestError('Invalid query')
  }
  for (const value of Object.values(ctx.query)) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
      throw new InternetApiRequestError('Invalid query value')
    }
  }
}

function queryInteger(ctx: Context, key: string, minimum: number, maximum: number): number | undefined {
  const value = ctx.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new InternetApiRequestError('Invalid query integer')
  }
  return optionalInteger(Number(value), minimum, maximum)
}

function queryEnum<T extends string>(ctx: Context, key: string, allowed: readonly T[]): T | undefined {
  return optionalEnum(ctx.query[key], allowed)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  throw new InternetApiRequestError('Invalid public result')
}

function coded(code: string): Error { return new Error(code) }
