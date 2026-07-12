import type { Context } from 'koa'
import {
  approveFabricWorkflow,
  cancelFabricWorkflow,
  createFabricIntent,
  getFabricControlState,
  getFabricWorkflow,
  listFabricAuditEvents,
  listFabricCapabilities,
  listFabricExecutors,
  listFabricWorkflows,
  rejectFabricWorkflow,
  requestFabricCompensation,
  retryFabricWorkflow,
  setFabricEmergencyStop,
  verifyFabricAuditChain,
} from '../../services/hermes/action-fabric'
import type {
  FabricActionIntentInput,
  FabricActionIntent,
  FabricAuditAggregateType,
  FabricAuditEvent,
  FabricCapability,
  FabricControlState,
  FabricEvidence,
  FabricExecutor,
  FabricIntentResult,
  FabricJsonObject,
  FabricPolicyDecision,
  FabricStep,
  FabricWorkflowDetail,
  FabricWorkflowListOptions,
  FabricWorkflowState,
  FabricWorkflowSummary,
} from '../../services/hermes/action-fabric'
import { listAssistantRolesWithMappings } from '../../services/hermes/personal-twin'
import { isFabricSensitiveString } from '../../services/hermes/action-fabric/audit'

class FabricRequestError extends Error {}

const MAX_BODY_BYTES = 65_536
const MAX_JSON_BYTES = 32_768
const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 4_096
const MAX_JSON_ITEMS = 64
const MAX_STRING_BYTES = 8_192
const MAX_LIST_LIMIT = 200
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const CURRENCY = /^[A-Z]{3}$/
const WORKFLOW_STATES = new Set<FabricWorkflowState>([
  'draft', 'policy_check', 'preparing', 'executing', 'verifying', 'waiting_user', 'retrying',
  'compensating', 'succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated',
])
const AGGREGATE_TYPES = new Set<FabricAuditAggregateType>([
  'capability', 'executor', 'intent', 'workflow', 'control', 'system',
])
const INTENT_FIELDS = new Set([
  'capabilityId', 'requestedByRoleId', 'idempotencyKey', 'goal', 'target', 'input',
  'constraints', 'rationale', 'expectedCost',
])
const SENSITIVE_KEY = /(?:secret|token|password|credential|cookie|authorization|configuration|path|directory|raw.?error|sql|jwt|api.?key|dsn|file|home|uri|url)/i

export async function capabilities(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set(['domain', 'risk', 'enabled', 'limit']))
    const limit = queryLimit(ctx)
    const domain = queryIdentifier(ctx, 'domain')
    const risk = queryEnum(ctx, 'risk', ['none', 'low', 'medium', 'high', 'critical'] as const)
    const enabled = queryBoolean(ctx, 'enabled')
    const result = publicServiceArray<FabricCapability>(listFabricCapabilities())
      .filter(item => domain === undefined || item.domain === domain)
      .filter(item => risk === undefined || item.risk === risk)
      .filter(item => enabled === undefined || item.enabled === enabled)
      .slice(0, limit)
      .map(publicCapability)
    return { capabilities: result }
  })
}

export async function executors(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set(['type', 'environment', 'health', 'enabled', 'limit']))
    const limit = queryLimit(ctx)
    const type = queryEnum(ctx, 'type', ['simulator', 'internal'] as const)
    const environment = queryEnum(ctx, 'environment', ['simulator', 'internal', 'sandbox', 'production'] as const)
    const health = queryEnum(ctx, 'health', ['unknown', 'healthy', 'degraded', 'unhealthy'] as const)
    const enabled = queryBoolean(ctx, 'enabled')
    const result = publicServiceArray<FabricExecutor>(listFabricExecutors())
      .filter(item => type === undefined || item.type === type)
      .filter(item => environment === undefined || item.environment === environment)
      .filter(item => health === undefined || item.health === health)
      .filter(item => enabled === undefined || item.enabled === enabled)
      .slice(0, limit)
      .map(publicExecutor)
    return { executors: result }
  })
}

export async function createIntent(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const body = requestBody(ctx, INTENT_FIELDS)
    const requestedByRoleId = requiredIdentifier(body, 'requestedByRoleId', 200)
    const role = listAssistantRolesWithMappings().find(item => item.id === requestedByRoleId)
    if (!role) throw publicError('FABRIC_ROLE_NOT_FOUND')
    if (!role.enabled || role.capabilityScope.enforcement !== 'action_fabric_v1') {
      throw publicError('FABRIC_ROLE_UNAVAILABLE')
    }
    const expectedCost = parseMoney(body.expectedCost)
    const input: FabricActionIntentInput = {
      capabilityId: requiredIdentifier(body, 'capabilityId', 200),
      requestedByRoleId,
      requestedByUserId: actorUserId(ctx),
      idempotencyKey: requiredIdentifier(body, 'idempotencyKey', 256),
      goal: requiredText(body, 'goal', 2_000),
      target: requiredJsonObject(body, 'target'),
      input: requiredJsonObject(body, 'input'),
      constraints: requiredJsonObject(body, 'constraints'),
      rationale: requiredText(body, 'rationale', 2_000),
      ...(expectedCost === undefined ? {} : { expectedCost }),
    }
    const result = createFabricIntent(input)
    ctx.status = 200
    return publicIntentResult(result)
  })
}

export async function workflows(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set(['state', 'capabilityId', 'requestedByRoleId', 'requestedByUserId', 'cursor', 'limit']))
    const options: FabricWorkflowListOptions = {}
    const state = queryEnum(ctx, 'state', [...WORKFLOW_STATES] as FabricWorkflowState[])
    const capabilityId = queryIdentifier(ctx, 'capabilityId')
    const requestedByRoleId = queryIdentifier(ctx, 'requestedByRoleId')
    const requestedByUserId = queryIdentifier(ctx, 'requestedByUserId')
    const cursor = queryIdentifier(ctx, 'cursor')
    if (state !== undefined) options.state = state
    if (capabilityId !== undefined) options.capabilityId = capabilityId
    if (requestedByRoleId !== undefined) options.requestedByRoleId = requestedByRoleId
    if (requestedByUserId !== undefined) options.requestedByUserId = requestedByUserId
    if (cursor !== undefined) options.cursor = cursor
    options.limit = queryLimit(ctx)
    const result = publicServiceArray<FabricWorkflowSummary>(listFabricWorkflows(options))
    return {
      workflows: result.map(publicWorkflowSummary),
      nextCursor: result.length === options.limit ? result.at(-1)?.id ?? null : null,
    }
  })
}

export async function workflowDetail(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set())
    const workflow = getFabricWorkflow(pathId(ctx))
    if (!workflow) throw publicError('FABRIC_WORKFLOW_NOT_FOUND')
    return { workflow: publicWorkflowDetail(workflow) }
  })
}

export async function approveWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => {
    requestBody(ctx, new Set())
    return { workflow: publicWorkflowDetail(approveFabricWorkflow(pathId(ctx), actorUserId(ctx))) }
  })
}

export async function rejectWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: publicWorkflowDetail(rejectFabricWorkflow(pathId(ctx), actorUserId(ctx), reasonBody(ctx))) }))
}

export async function cancelWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: publicWorkflowDetail(cancelFabricWorkflow(pathId(ctx), actorUserId(ctx), reasonBody(ctx))) }))
}

export async function retryWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => {
    requestBody(ctx, new Set())
    return { workflow: publicWorkflowDetail(retryFabricWorkflow(pathId(ctx), actorUserId(ctx))) }
  })
}

export async function compensateWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: publicWorkflowDetail(requestFabricCompensation(pathId(ctx), actorUserId(ctx), reasonBody(ctx))) }))
}

export async function auditEvents(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set(['aggregateType', 'aggregateId', 'eventType', 'afterSequence', 'limit']))
    const aggregateType = queryEnum(ctx, 'aggregateType', [...AGGREGATE_TYPES] as FabricAuditAggregateType[])
    const aggregateId = queryIdentifier(ctx, 'aggregateId', 500)
    const eventType = queryIdentifier(ctx, 'eventType', 200)
    const afterSequence = queryInteger(ctx, 'afterSequence', 0, Number.MAX_SAFE_INTEGER)
    const limit = queryLimit(ctx)
    const events = publicServiceArray<FabricAuditEvent>(listFabricAuditEvents({
      ...(aggregateType === undefined ? {} : { aggregateType }),
      ...(aggregateId === undefined ? {} : { aggregateId }),
      ...(eventType === undefined ? {} : { eventType }),
      ...(afterSequence === undefined ? {} : { afterSequence }),
      limit,
    })).map(publicAuditEvent)
    return { events, nextAfterSequence: events.length === limit ? events.at(-1)?.sequence ?? null : null }
  })
}

export async function verifyAudit(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set())
    const result = publicRecord(verifyFabricAuditChain())
    return { verification: {
      valid: result.valid === true,
      checked: safeNonNegativeInteger(result.checked),
      firstInvalidSequence: result.firstInvalidSequence === null ? null : safeNonNegativeInteger(result.firstInvalidSequence),
      ...(typeof result.legacyValid === 'boolean' ? { legacyValid: result.legacyValid } : {}),
      ...(typeof result.needsMigration === 'boolean' ? { needsMigration: result.needsMigration } : {}),
    } }
  })
}

export async function control(ctx: Context): Promise<void> {
  respond(ctx, () => {
    validateQuery(ctx, new Set())
    return { control: publicControl(getFabricControlState()) }
  })
}

export async function updateEmergencyStop(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const body = requestBody(ctx, new Set(['level', 'reason', 'expectedVersion']))
    if (!Number.isSafeInteger(body.level) || (body.level as number) < 0 || (body.level as number) > 3) {
      throw new FabricRequestError('level must be an integer from 0 to 3')
    }
    const reason = requiredText(body, 'reason', 2_000)
    const expectedVersion = requiredInteger(body, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER)
    return { control: publicControl(setFabricEmergencyStop(
      body.level as 0 | 1 | 2 | 3, actorUserId(ctx), reason, expectedVersion,
    )) }
  })
}

function respond(ctx: Context, operation: () => unknown): void {
  try {
    ctx.body = operation()
  } catch (error) {
    mapError(ctx, error)
  }
}

function requestBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') {
    throw new FabricRequestError('Content-Type must be application/json')
  }
  const body = request.body
  assertStrictJson(body, 0, { nodes: 0, bytes: 0 }, new WeakSet())
  if (!isPlainObject(body)) throw new FabricRequestError('Request body must be a JSON object')
  const encoded = JSON.stringify(body)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) throw new FabricRequestError('Request body is too large')
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new FabricRequestError(`Unexpected field: ${key}`)
  }
  return body
}

function assertStrictJson(
  value: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
  ancestors: WeakSet<object>,
): void {
  budget.nodes += 1
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) throw new FabricRequestError('JSON value is too large')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8')
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES || budget.bytes > MAX_BODY_BYTES) {
      throw new FabricRequestError('JSON string is too large')
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FabricRequestError('JSON number must be finite')
    return
  }
  if (typeof value !== 'object') throw new FabricRequestError('Request contains a non-JSON value')
  if (ancestors.has(value)) throw new FabricRequestError('Request contains a JSON cycle')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_JSON_ITEMS) {
        throw new FabricRequestError('Invalid JSON array')
      }
      const keys = Reflect.ownKeys(value)
      if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new FabricRequestError('Invalid JSON array keys')
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new FabricRequestError('Invalid JSON array entry')
        assertStrictJson(descriptor.value, depth + 1, budget, ancestors)
      }
      return
    }
    if (!isPlainObject(value)) throw new FabricRequestError('JSON objects must be plain objects')
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_JSON_ITEMS || keys.some(key => typeof key !== 'string')) {
      throw new FabricRequestError('Invalid JSON object keys')
    }
    for (const key of keys as string[]) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new FabricRequestError('Unsafe JSON key')
      }
      budget.bytes += Buffer.byteLength(key, 'utf8')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new FabricRequestError('JSON properties must be data properties')
      assertStrictJson(descriptor.value, depth + 1, budget, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredJsonObject(body: Record<string, unknown>, field: string): FabricJsonObject {
  const value = body[field]
  if (!isPlainObject(value)) throw new FabricRequestError(`${field} must be a JSON object`)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) throw new FabricRequestError(`${field} is too large`)
  return value
}

function requiredText(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new FabricRequestError(`${field} must be a bounded non-empty string`)
  }
  if (isFabricSensitiveString(value)) throw new FabricRequestError(`${field} contains sensitive material`)
  return value
}

function requiredIdentifier(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length > max || !ID.test(value)) {
    throw new FabricRequestError(`${field} must be a valid identifier`)
  }
  return value
}

function parseMoney(value: unknown): { currency: string; amountMinor: number } | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw new FabricRequestError('expectedCost must be a JSON object')
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('currency') || !keys.includes('amountMinor')) {
    throw new FabricRequestError('expectedCost has unexpected fields')
  }
  if (typeof value.currency !== 'string' || !CURRENCY.test(value.currency)) {
    throw new FabricRequestError('expectedCost.currency must be an ISO currency code')
  }
  if (!Number.isSafeInteger(value.amountMinor) || (value.amountMinor as number) < 0) {
    throw new FabricRequestError('expectedCost.amountMinor must be a non-negative integer')
  }
  return { currency: value.currency, amountMinor: value.amountMinor as number }
}

function reasonBody(ctx: Context): string {
  const body = requestBody(ctx, new Set(['reason']))
  return requiredText(body, 'reason', 2_000)
}

function actorUserId(ctx: Context): string {
  const value = ctx.state.user?.id
  const actor = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === 'string' ? value : ''
  if (!actor || actor.length > 200 || !ID.test(actor)) throw publicError('FABRIC_ACTOR_UNAVAILABLE')
  return actor
}

function pathId(ctx: Context): string {
  const raw = typeof ctx.params.id === 'string' ? ctx.params.id : ''
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { throw new FabricRequestError('Invalid path identifier') }
  if (decoded.length > 200 || !ID.test(decoded)) throw new FabricRequestError('Invalid path identifier')
  return decoded
}

function validateQuery(ctx: Context, allowed: ReadonlySet<string>): void {
  const query = ctx.query as unknown
  if (!isPlainObject(query)) throw new FabricRequestError('Query parameters must be a plain object')
  const keys = Reflect.ownKeys(query)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new FabricRequestError('Unexpected query parameter')
    const descriptor = Object.getOwnPropertyDescriptor(query, key)
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string'
      || descriptor.value.length === 0) {
      throw new FabricRequestError(`Invalid ${key} query parameter`)
    }
  }
}

function queryRaw(ctx: Context, name: string): string | undefined {
  const value = ctx.query[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new FabricRequestError(`${name} query parameter must be singular`)
  return value
}

function queryIdentifier(ctx: Context, name: string, max = 200): string | undefined {
  const value = queryRaw(ctx, name)
  if (value === undefined) return undefined
  if (value.length > max || !ID.test(value)) throw new FabricRequestError(`Invalid ${name} query parameter`)
  return value
}

function queryEnum<T extends string>(ctx: Context, name: string, values: readonly T[]): T | undefined {
  const value = queryRaw(ctx, name)
  if (value === undefined) return undefined
  if (!values.includes(value as T)) throw new FabricRequestError(`Invalid ${name} query parameter`)
  return value as T
}

function queryBoolean(ctx: Context, name: string): boolean | undefined {
  const value = queryRaw(ctx, name)
  if (value === undefined) return undefined
  if (value !== 'true' && value !== 'false') throw new FabricRequestError(`Invalid ${name} query parameter`)
  return value === 'true'
}

function queryInteger(ctx: Context, name: string, min: number, max: number): number | undefined {
  const value = queryRaw(ctx, name)
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new FabricRequestError(`Invalid ${name} query parameter`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new FabricRequestError(`Invalid ${name} query parameter`)
  return parsed
}

function queryLimit(ctx: Context): number {
  return queryInteger(ctx, 'limit', 1, MAX_LIST_LIMIT) ?? 100
}

function requiredInteger(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field]
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new FabricRequestError(`${field} must be a bounded integer`)
  }
  return value as number
}

function publicCapability(item: FabricCapability): Record<string, unknown> {
  const safe = publicRecord(item)
  return {
    id: publicText(safe.id), version: publicNumber(safe.version), domain: publicText(safe.domain),
    verb: publicText(safe.verb), description: publicText(safe.description),
    inputSchema: publicJson(safe.inputSchema), outputSchema: publicJson(safe.outputSchema), risk: publicText(safe.risk),
    sideEffect: safe.sideEffect === true, idempotency: publicText(safe.idempotency), reversible: safe.reversible === true,
    compensationCapabilityId: publicNullableText(safe.compensationCapabilityId),
    verificationStrategy: publicText(safe.verificationStrategy),
    authentication: publicStringArray(safe.authentication), targetRestrictions: publicStringArray(safe.targetRestrictions),
    cost: publicEstimatedCost(safe.cost), enabled: safe.enabled === true,
    createdAt: publicText(safe.createdAt), updatedAt: publicText(safe.updatedAt),
  }
}

function publicIntentResult(result: FabricIntentResult): Record<string, unknown> {
  const safe = publicRecord(result)
  return {
    intent: publicIntent(safe.intent),
    policyDecision: publicPolicyDecision(safe.policyDecision),
    workflow: publicWorkflowDetail(safe.workflow),
  }
}

function publicIntent(intent: unknown): Record<string, unknown> {
  const safe = publicRecord(intent)
  return {
    id: publicText(safe.id), capabilityId: publicText(safe.capabilityId),
    capabilityVersion: publicNumber(safe.capabilityVersion), requestedByRoleId: publicText(safe.requestedByRoleId),
    requestedByUserId: publicText(safe.requestedByUserId), idempotencyKey: publicText(safe.idempotencyKey),
    goal: publicText(safe.goal), target: publicJson(safe.target), input: publicJson(safe.input),
    constraints: publicJson(safe.constraints), rationale: publicText(safe.rationale),
    ...(safe.expectedCost === undefined ? {} : { expectedCost: publicMoney(safe.expectedCost) }),
    sanitizedSummary: publicJson(safe.sanitizedSummary),
    createdAt: publicText(safe.createdAt), updatedAt: publicText(safe.updatedAt),
  }
}

function publicWorkflowBase(workflow: unknown): Record<string, unknown> {
  const safe = publicRecord(workflow)
  return {
    id: publicText(safe.id), intentId: publicText(safe.intentId), executorId: publicNullableText(safe.executorId),
    policyDecisionId: publicNullableText(safe.policyDecisionId),
    compensationIntentId: publicNullableText(safe.compensationIntentId), state: publicText(safe.state),
    version: publicNumber(safe.version), attempt: publicNumber(safe.attempt), maxAttempts: publicNumber(safe.maxAttempts),
    leaseExpiresAt: publicNullableText(safe.leaseExpiresAt), retryAt: publicNullableText(safe.retryAt),
    lastErrorCode: publicNullableText(safe.lastErrorCode), capabilityId: publicText(safe.capabilityId),
    goal: publicText(safe.goal), requestedByRoleId: publicText(safe.requestedByRoleId),
    requestedByUserId: publicText(safe.requestedByUserId), createdAt: publicText(safe.createdAt),
    updatedAt: publicText(safe.updatedAt), completedAt: publicNullableText(safe.completedAt),
  }
}

function publicWorkflowSummary(workflow: FabricWorkflowSummary): Record<string, unknown> {
  return publicWorkflowBase(workflow)
}

function publicWorkflowDetail(workflow: unknown): Record<string, unknown> {
  const safe = publicRecord(workflow)
  return {
    ...publicWorkflowBase(safe),
    intent: publicIntent(safe.intent),
    steps: publicMappedArray(safe.steps, publicStep),
    policyDecision: safe.policyDecision === null ? null : publicPolicyDecision(safe.policyDecision),
  }
}

function publicStep(step: unknown): Record<string, unknown> {
  const safe = publicRecord(step)
  return {
    id: publicText(safe.id), workflowId: publicText(safe.workflowId), ordinal: publicNumber(safe.ordinal),
    kind: publicText(safe.kind), state: publicText(safe.state), executorId: publicNullableText(safe.executorId),
    input: publicJson(safe.input), output: safe.output === null ? null : publicJson(safe.output),
    evidence: publicMappedArray(safe.evidence, publicEvidence), attempt: publicNumber(safe.attempt),
    lastErrorCode: publicNullableText(safe.lastErrorCode), createdAt: publicText(safe.createdAt),
    updatedAt: publicText(safe.updatedAt), startedAt: publicNullableText(safe.startedAt),
    completedAt: publicNullableText(safe.completedAt),
  }
}

function publicEvidence(evidence: unknown): Record<string, unknown> {
  const safe = publicRecord(evidence)
  return {
    kind: publicText(safe.kind), summary: publicText(safe.summary), data: publicJson(safe.data),
    capturedAt: publicText(safe.capturedAt),
  }
}

function publicPolicyDecision(decision: unknown): Record<string, unknown> {
  const safe = publicRecord(decision)
  return {
    id: publicText(safe.id), intentId: publicText(safe.intentId), executorId: publicNullableText(safe.executorId),
    outcome: publicText(safe.outcome), reasonCodes: publicStringArray(safe.reasonCodes),
    policyVersion: publicNumber(safe.policyVersion), sanitizedSummary: publicJson(safe.sanitizedSummary),
    budget: safe.budget === null ? null : publicMoney(safe.budget), createdAt: publicText(safe.createdAt),
  }
}

function publicControl(state: FabricControlState): Record<string, unknown> {
  const safe = publicRecord(state)
  return {
    level: publicNumber(safe.level), version: publicNumber(safe.version),
    actorUserId: publicNullableText(safe.actorUserId), reason: publicText(safe.reason),
    updatedAt: publicText(safe.updatedAt),
  }
}

function publicExecutor(item: FabricExecutor): Record<string, unknown> {
  const safe = publicRecord(item)
  return {
    id: publicText(safe.id), type: publicText(safe.type), name: publicText(safe.name),
    environment: publicText(safe.environment), health: publicText(safe.health), enabled: safe.enabled === true,
    policyVersion: publicNumber(safe.policyVersion), createdAt: publicText(safe.createdAt), updatedAt: publicText(safe.updatedAt),
  }
}

function publicAuditEvent(event: FabricAuditEvent): Record<string, unknown> {
  const safe = publicRecord(event)
  return {
    id: publicText(safe.id), sequence: publicNumber(safe.sequence), eventType: publicText(safe.eventType),
    actorUserId: publicText(safe.actorUserId), aggregateType: publicText(safe.aggregateType),
    aggregateId: publicText(safe.aggregateId), payload: publicJson(safe.payload), occurredAt: publicText(safe.occurredAt),
    previousHash: publicText(safe.previousHash), hash: publicText(safe.hash),
  }
}

function publicRecord(value: unknown): Record<string, unknown> {
  const safe = publicJson(value)
  return isPlainObject(safe) ? safe : {}
}

function publicText(value: unknown): string {
  return typeof value === 'string' ? safeString(value) : '[REDACTED]'
}

function publicNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : publicText(value)
}

function publicNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function publicMoney(value: unknown): Record<string, unknown> {
  const safe = publicRecord(value)
  return { currency: publicNullableText(safe.currency), amountMinor: publicNumber(safe.amountMinor) }
}

function publicEstimatedCost(value: unknown): Record<string, unknown> {
  const safe = publicRecord(value)
  return { currency: publicNullableText(safe.currency), estimatedMinor: publicNumber(safe.estimatedMinor) }
}

function publicStringArray(value: unknown): string[] {
  return publicMappedArray(value, publicText)
}

function publicMappedArray<T>(value: unknown, projector: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_JSON_ITEMS).map(projector)
}

function publicServiceArray<T>(value: unknown): T[] {
  const safe = publicJson(value)
  return Array.isArray(safe) ? safe as T[] : []
}

function publicJson(value: unknown): unknown {
  return sanitizePublicJson(value, 0, { nodes: 0, bytes: 0 }, new WeakSet())
}

function sanitizePublicJson(
  value: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
  ancestors: WeakSet<object>,
): unknown {
  budget.nodes += 1
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES || budget.bytes > MAX_JSON_BYTES) return '[TRUNCATED]'
  if (typeof value === 'string') return safeString(value)
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (typeof value !== 'object') return '[REDACTED]'
  if (ancestors.has(value)) return '[REDACTED]'
  ancestors.add(value)
  try {
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (let index = 0; index < Math.min(value.length, MAX_JSON_ITEMS); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      output.push(descriptor?.enumerable && 'value' in descriptor
        ? sanitizePublicJson(descriptor.value, depth + 1, budget, ancestors) : '[REDACTED]')
    }
    return output
  }
  if (!isPlainObject(value)) return '[REDACTED]'
  const output: Record<string, unknown> = {}
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string').slice(0, MAX_JSON_ITEMS)
  for (const key of keys) {
    budget.bytes += Buffer.byteLength(key, 'utf8')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (SENSITIVE_KEY.test(key)) continue
    output[key] = !descriptor?.enumerable || !('value' in descriptor)
      ? '[REDACTED]' : sanitizePublicJson(descriptor.value, depth + 1, budget, ancestors)
  }
  return output
  } finally {
    ancestors.delete(value)
  }
}

function safeString(value: string): string {
  if (typeof value !== 'string' || isFabricSensitiveString(value)) return '[REDACTED]'
  return Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ? '[TRUNCATED]' : value
}

function safeNonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function publicError(code: string): Error {
  return new Error(code)
}

type PublicErrorRule = {
  status: 400 | 403 | 404 | 409 | 422 | 503
  message: string
  exact?: ReadonlySet<string>
  prefixes?: readonly string[]
}

const PUBLIC_ERROR_RULES: readonly PublicErrorRule[] = [
  {
    status: 403, message: 'Authenticated user is required',
    exact: new Set(['FABRIC_ACTOR_UNAVAILABLE']),
  },
  {
    status: 503, message: 'Action Fabric is unavailable',
    prefixes: [
      'FABRIC_AUDIT_KEY_', 'FABRIC_AUDIT_WRITER_', 'FABRIC_AUDIT_ANCHOR_',
      'FABRIC_AUDIT_CHAIN_', 'FABRIC_AUDIT_FORMAT_', 'FABRIC_AUDIT_LEGACY_',
      'FABRIC_EMERGENCY_', 'FABRIC_RUNTIME_', 'FABRIC_EXECUTOR_ADAPTER_',
    ],
  },
  {
    status: 404, message: 'Action Fabric resource not found',
    exact: new Set([
      'FABRIC_ROLE_NOT_FOUND', 'FABRIC_WORKFLOW_NOT_FOUND', 'FABRIC_INTENT_NOT_FOUND',
      'FABRIC_POLICY_DECISION_NOT_FOUND', 'FABRIC_WORKFLOW_POLICY_NOT_FOUND',
      'FABRIC_WORKFLOW_BUDGET_NOT_FOUND', 'FABRIC_EXECUTOR_NOT_FOUND', 'FABRIC_CAPABILITY_NOT_FOUND',
    ]),
  },
  {
    status: 409, message: 'Action Fabric state changed',
    prefixes: ['FABRIC_IDEMPOTENCY_'],
    exact: new Set([
      'FABRIC_BUDGET_RESERVATION_MISSING', 'FABRIC_BUDGET_ALREADY_RELEASED',
      'FABRIC_BUDGET_ALREADY_COMMITTED', 'FABRIC_BUDGET_OWNERSHIP_CONFLICT',
      'FABRIC_BUDGET_NOT_RESERVABLE', 'FABRIC_BUDGET_COMMIT_CONFLICT', 'FABRIC_BUDGET_CONFLICT',
      'FABRIC_CONTROL_VERSION_CONFLICT', 'FABRIC_WORKFLOW_POLICY_CONFLICT', 'FABRIC_WORKFLOW_CONFLICT',
      'FABRIC_WORKFLOW_APPROVAL_STALE', 'FABRIC_WORKFLOW_CONTRACT_STALE',
      'FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE', 'FABRIC_COMPENSATION_WORKFLOW_CONFLICT',
      'FABRIC_EXECUTOR_POLICY_STALE', 'FABRIC_POLICY_STALE_ROLE',
      'FABRIC_POLICY_STALE_REGISTRY', 'FABRIC_POLICY_STALE_CONTROL',
    ]),
  },
  {
    status: 422, message: 'Action request cannot be processed',
    exact: new Set([
      'FABRIC_BUDGET_LIMIT_EXCEEDED', 'FABRIC_BUDGET_CURRENCY_MISMATCH',
      'FABRIC_ROLE_UNAVAILABLE', 'FABRIC_WORKFLOW_NOT_RETRYABLE', 'FABRIC_WORKFLOW_NOT_COMPENSATABLE',
      'FABRIC_WORKFLOW_INVALID_TRANSITION', 'FABRIC_WORKFLOW_APPROVAL_REQUIRED',
    ]),
    prefixes: ['FABRIC_POLICY_INVALID_', 'FABRIC_POLICY_DENIED', 'FABRIC_POLICY_WAITING_'],
  },
  {
    status: 400, message: 'Invalid request',
    exact: new Set(['FABRIC_BUDGET_INVALID_MONEY']),
    prefixes: [
      'FABRIC_REQUEST_', 'FABRIC_WORKFLOW_INVALID_', 'FABRIC_WORKFLOW_PAYLOAD_',
      'FABRIC_WORKFLOW_SENSITIVE_', 'FABRIC_AUDIT_INVALID_', 'FABRIC_LIST_INVALID_',
      'FABRIC_AUDIT_INPUT_', 'FABRIC_CONTROL_INVALID_', 'FABRIC_OUTBOX_INVALID_', 'FABRIC_INTENT_INVALID_',
    ],
  },
]

function mapError(ctx: Context, error: unknown): void {
  if (error instanceof FabricRequestError) {
    ctx.status = 400
    ctx.body = { error: 'Invalid request', code: 'FABRIC_REQUEST_INVALID' }
    return
  }
  const raw = error instanceof Error ? error.message : ''
  const code = /^FABRIC_[A-Z0-9_]+/.exec(raw)?.[0]
  if (!code) {
    ctx.status = 500
    ctx.body = { error: 'Internal server error', code: 'FABRIC_INTERNAL_ERROR' }
    return
  }
  const rule = PUBLIC_ERROR_RULES.find(candidate => candidate.exact?.has(code)
    || candidate.prefixes?.some(prefix => code.startsWith(prefix)))
  if (rule) {
    let message = rule.message
    if (code === 'FABRIC_ROLE_NOT_FOUND') message = 'Assistant role not found'
    else if (code === 'FABRIC_WORKFLOW_NOT_FOUND') message = 'Action workflow not found'
    else if (code === 'FABRIC_WORKFLOW_NOT_RETRYABLE') message = 'Action workflow cannot be retried'
    else if (code === 'FABRIC_WORKFLOW_NOT_COMPENSATABLE') message = 'Action workflow cannot be compensated'
    ctx.status = rule.status
    ctx.body = { error: message, code }
    return
  }
  ctx.status = 500
  ctx.body = { error: 'Internal server error', code: 'FABRIC_INTERNAL_ERROR' }
}
