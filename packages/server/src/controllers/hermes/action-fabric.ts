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
  FabricAuditAggregateType,
  FabricAuditEvent,
  FabricCapability,
  FabricExecutor,
  FabricJsonObject,
  FabricWorkflowListOptions,
  FabricWorkflowState,
} from '../../services/hermes/action-fabric'
import { listAssistantRolesWithMappings } from '../../services/hermes/personal-twin'

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
const SENSITIVE_KEY = /(?:secret|token|password|credential|cookie|authorization|configuration|path|directory|rawerror|sql)/i
const SENSITIVE_VALUE = /(?:\b(?:password|secret|credential|token)\s*[:=]|\bsk-[A-Za-z0-9_-]{8,}|(?:[A-Za-z]:[\\/]|\/(?:home|Users|root|var|tmp|data)\/)|(?:postgres|mysql|mongodb|redis|sqlite):\/\/)/i

export async function capabilities(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const limit = queryLimit(ctx)
    const domain = queryIdentifier(ctx, 'domain')
    const risk = queryEnum(ctx, 'risk', ['none', 'low', 'medium', 'high', 'critical'] as const)
    const enabled = queryBoolean(ctx, 'enabled')
    const result = listFabricCapabilities()
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
    const limit = queryLimit(ctx)
    const type = queryEnum(ctx, 'type', ['simulator', 'internal'] as const)
    const environment = queryEnum(ctx, 'environment', ['simulator', 'internal', 'sandbox', 'production'] as const)
    const health = queryEnum(ctx, 'health', ['unknown', 'healthy', 'degraded', 'unhealthy'] as const)
    const enabled = queryBoolean(ctx, 'enabled')
    const result = listFabricExecutors()
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
    return result
  })
}

export async function workflows(ctx: Context): Promise<void> {
  respond(ctx, () => {
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
    const result = listFabricWorkflows(options)
    return { workflows: result, nextCursor: result.length === options.limit ? result.at(-1)?.id ?? null : null }
  })
}

export async function workflowDetail(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const workflow = getFabricWorkflow(pathId(ctx))
    if (!workflow) throw publicError('FABRIC_WORKFLOW_NOT_FOUND')
    return { workflow }
  })
}

export async function approveWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => {
    requestBody(ctx, new Set())
    return { workflow: approveFabricWorkflow(pathId(ctx), actorUserId(ctx)) }
  })
}

export async function rejectWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: rejectFabricWorkflow(pathId(ctx), actorUserId(ctx), reasonBody(ctx)) }))
}

export async function cancelWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: cancelFabricWorkflow(pathId(ctx), actorUserId(ctx), reasonBody(ctx)) }))
}

export async function retryWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => {
    requestBody(ctx, new Set())
    return { workflow: retryFabricWorkflow(pathId(ctx), actorUserId(ctx)) }
  })
}

export async function compensateWorkflow(ctx: Context): Promise<void> {
  respond(ctx, () => ({ workflow: requestFabricCompensation(pathId(ctx), actorUserId(ctx), reasonBody(ctx)) }))
}

export async function auditEvents(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const aggregateType = queryEnum(ctx, 'aggregateType', [...AGGREGATE_TYPES] as FabricAuditAggregateType[])
    const aggregateId = queryIdentifier(ctx, 'aggregateId', 500)
    const eventType = queryIdentifier(ctx, 'eventType', 200)
    const afterSequence = queryInteger(ctx, 'afterSequence', 0, Number.MAX_SAFE_INTEGER)
    const limit = queryLimit(ctx)
    const events = listFabricAuditEvents({
      ...(aggregateType === undefined ? {} : { aggregateType }),
      ...(aggregateId === undefined ? {} : { aggregateId }),
      ...(eventType === undefined ? {} : { eventType }),
      ...(afterSequence === undefined ? {} : { afterSequence }),
      limit,
    }).map(publicAuditEvent)
    return { events, nextAfterSequence: events.length === limit ? events.at(-1)?.sequence ?? null : null }
  })
}

export async function verifyAudit(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const result = verifyFabricAuditChain()
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
  respond(ctx, () => ({ control: getFabricControlState() }))
}

export async function updateEmergencyStop(ctx: Context): Promise<void> {
  respond(ctx, () => {
    const body = requestBody(ctx, new Set(['level', 'reason', 'expectedVersion']))
    if (!Number.isSafeInteger(body.level) || (body.level as number) < 0 || (body.level as number) > 3) {
      throw new FabricRequestError('level must be an integer from 0 to 3')
    }
    const reason = requiredText(body, 'reason', 2_000)
    const expectedVersion = requiredInteger(body, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER)
    return { control: setFabricEmergencyStop(body.level as 0 | 1 | 2 | 3, actorUserId(ctx), reason, expectedVersion) }
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
  return {
    id: item.id, version: item.version, domain: item.domain, verb: item.verb, description: safeString(item.description),
    inputSchema: publicJson(item.inputSchema), outputSchema: publicJson(item.outputSchema), risk: item.risk,
    sideEffect: item.sideEffect, idempotency: item.idempotency, reversible: item.reversible,
    compensationCapabilityId: item.compensationCapabilityId, verificationStrategy: item.verificationStrategy,
    authentication: item.authentication.slice(0, MAX_JSON_ITEMS).map(safeString),
    targetRestrictions: item.targetRestrictions.slice(0, MAX_JSON_ITEMS).map(safeString),
    cost: item.cost, enabled: item.enabled, createdAt: item.createdAt, updatedAt: item.updatedAt,
  }
}

function publicExecutor(item: FabricExecutor): Record<string, unknown> {
  return {
    id: item.id, type: item.type, name: safeString(item.name), environment: item.environment,
    health: item.health, enabled: item.enabled, policyVersion: item.policyVersion,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  }
}

function publicAuditEvent(event: FabricAuditEvent): Record<string, unknown> {
  return {
    id: event.id, sequence: event.sequence, eventType: event.eventType, actorUserId: event.actorUserId,
    aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: publicJson(event.payload),
    occurredAt: event.occurredAt, previousHash: event.previousHash, hash: event.hash,
  }
}

function publicJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return safeString(value)
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (let index = 0; index < Math.min(value.length, MAX_JSON_ITEMS); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      output.push(descriptor?.enumerable && 'value' in descriptor ? publicJson(descriptor.value, depth + 1) : '[REDACTED]')
    }
    return output
  }
  if (!isPlainObject(value)) return '[REDACTED]'
  const output: Record<string, unknown> = {}
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string').slice(0, MAX_JSON_ITEMS)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    output[key] = SENSITIVE_KEY.test(key) || !descriptor?.enumerable || !('value' in descriptor)
      ? '[REDACTED]'
      : publicJson(descriptor.value, depth + 1)
  }
  return output
}

function safeString(value: string): string {
  if (typeof value !== 'string' || SENSITIVE_VALUE.test(value)) return '[REDACTED]'
  return Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ? '[TRUNCATED]' : value
}

function safeNonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function publicError(code: string): Error {
  return new Error(code)
}

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
  if (code === 'FABRIC_ACTOR_UNAVAILABLE') {
    ctx.status = 403; ctx.body = { error: 'Authenticated user is required', code }; return
  }
  if (code === 'FABRIC_ROLE_NOT_FOUND' || code.endsWith('_NOT_FOUND')) {
    ctx.status = 404
    ctx.body = { error: code === 'FABRIC_ROLE_NOT_FOUND' ? 'Assistant role not found' : 'Action workflow not found', code }
    return
  }
  if (code.includes('CONFLICT') || code.includes('STALE') || code.includes('ALREADY_')) {
    ctx.status = 409; ctx.body = { error: 'Action Fabric state changed', code }; return
  }
  if (code === 'FABRIC_ROLE_UNAVAILABLE' || code.includes('NOT_RETRYABLE') || code.includes('NOT_COMPENSATABLE')
    || code.includes('INVALID_TRANSITION')) {
    ctx.status = 422
    ctx.body = { error: code.includes('NOT_RETRYABLE') ? 'Action workflow cannot be retried'
      : code.includes('NOT_COMPENSATABLE') ? 'Action workflow cannot be compensated'
        : code === 'FABRIC_ROLE_UNAVAILABLE' ? 'Assistant role is unavailable' : 'Action workflow transition is not allowed', code }
    return
  }
  if (code.includes('EMERGENCY') || code.includes('UNAVAILABLE') || code.includes('AUDIT_CHAIN') || code.includes('ANCHOR')) {
    ctx.status = 503; ctx.body = { error: 'Action Fabric is unavailable', code }; return
  }
  if (code.includes('INVALID') || code.includes('LIMIT') || code.includes('SENSITIVE') || code.includes('REQUIRED')) {
    ctx.status = 400; ctx.body = { error: 'Invalid request', code }; return
  }
  ctx.status = 500
  ctx.body = { error: 'Internal server error', code: 'FABRIC_INTERNAL_ERROR' }
}
