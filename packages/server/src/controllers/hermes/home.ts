import { createHash, randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Context } from 'koa'
import {
  approveFabricWorkflow,
  createFabricIntent,
  getFabricWorkflow,
  listFabricWorkflows,
  rejectFabricWorkflow,
  type FabricWorkflowDetail,
} from '../../services/hermes/action-fabric'
import {
  assertHomeCapabilityBindingAllowed,
  getHomeProductionRuntimeStatus,
  HomeIdentityConflictError,
  HomeRecordNotFoundError,
  HomeTwinStore,
  HomeValidationError,
  HomeVersionConflictError,
  reconcileHomeProductionRuntime,
  refreshHomeManagerAuthorization,
} from '../../services/hermes/home'
import { withPersonalTwinDb } from '../../services/hermes/personal-twin/database'

class HomeRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const PROVIDER = 'home-assistant'
const MAX_JSON_BYTES = 65_536
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SENSITIVE_KEY = /(?:token|password|secret|credential|authorization|cookie|api.?key|private.?key|service(?:_data)?)/i

/** @openapi-default-errors 400:HomeApiError,401:AuthError,403:AuthError,404:HomeApiError,409:HomeApiError,500:HomeApiError,503:HomeApiError */

/** @openapi-response HomeOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const data = withStore(store => {
      const spaces = store.listSpaces({ limit: 200 })
      const devices = store.listDevices({ limit: 200 })
      const inventory = store.listInventoryItems({ limit: 200 })
      return {
        spaceCount: spaces.length,
        deviceCount: devices.length,
        unavailableDeviceCount: devices.filter(device => device.availability !== 'available').length,
        inventoryItemCount: inventory.length,
        lowStockItemCount: inventory.filter(item => item.lowStockThreshold !== null
          && item.quantity <= item.lowStockThreshold).length,
      }
    })
    const activeWorkflowCount = listFabricWorkflows({ requestedByRoleId: 'home-manager', limit: 200 })
      .filter(workflow => !['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated']
        .includes(workflow.state)).length
    return { provider: publicProviderStatus(), summary: { ...data, activeWorkflowCount } }
  })
}

/** @openapi-response HomeSpaceListResponse */
export async function spaces(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['parentSpaceId', 'kind', 'limit']))
    const parent = queryId(ctx, 'parentSpaceId')
    const kind = queryEnum(ctx, 'kind', ['home', 'floor', 'room', 'zone', 'furniture', 'compartment', 'surface'] as const)
    const limit = queryInteger(ctx, 'limit', 1, 200)
    return { spaces: withStore(store => store.listSpaces({
      ...(parent === undefined ? {} : { parentSpaceId: parent }),
      ...(kind === undefined ? {} : { kind }),
      ...(limit === undefined ? {} : { limit }),
    })).map(space => ({ ...space, attributes: publicJsonObject(space.attributes) })) }
  })
}

/** @openapi-response HomeSpaceResponse */
export async function upsertSpace(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['id', 'kind', 'name', 'parentSpaceId', 'attributes', 'expectedVersion']))
    const expectedVersion = requiredInteger(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER)
    const space = withStore(store => store.upsertSpace({
      id: requiredId(body.id), kind: requiredEnum(body.kind,
        ['home', 'floor', 'room', 'zone', 'furniture', 'compartment', 'surface'] as const),
      name: requiredText(body.name, 200), parentSpaceId: nullableId(body.parentSpaceId),
      attributes: optionalObject(body.attributes), expectedVersion,
    }))
    ctx.status = expectedVersion === 0 ? 201 : 200
    return { space: { ...space, attributes: publicJsonObject(space.attributes) } }
  })
}

/** @openapi-response HomeInventoryListResponse */
export async function inventory(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['lowStockOnly', 'limit']))
    const lowStockOnly = queryBoolean(ctx, 'lowStockOnly')
    const limit = queryInteger(ctx, 'limit', 1, 200)
    return { items: withStore(store => store.listInventoryItems({
      ...(lowStockOnly === undefined ? {} : { lowStockOnly }),
      ...(limit === undefined ? {} : { limit }),
    })).map(item => ({ ...item, attributes: publicJsonObject(item.attributes) })) }
  })
}

/** @openapi-response HomeInventoryResponse */
export async function upsertInventoryItem(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const id = pathId(ctx)
    const body = exactBody(ctx, new Set(['name', 'unit', 'initialQuantity', 'lowStockThreshold',
      'attributes', 'expectedVersion']))
    const expectedVersion = requiredInteger(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER)
    const item = withStore(store => store.upsertInventoryItem({
      id, name: requiredText(body.name, 200), unit: requiredText(body.unit, 40), expectedVersion,
      ...(body.initialQuantity === undefined ? {} : { initialQuantity: requiredNumber(body.initialQuantity, 0) }),
      ...(body.lowStockThreshold === undefined ? {} : { lowStockThreshold: nullableNumber(body.lowStockThreshold, 0) }),
      attributes: optionalObject(body.attributes),
    }))
    ctx.status = expectedVersion === 0 ? 201 : 200
    return { item: { ...item, attributes: publicJsonObject(item.attributes) } }
  })
}

/** @openapi-response HomeInventoryAdjustmentResponse */
export async function adjustInventory(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const itemId = pathId(ctx)
    const body = exactBody(ctx, new Set(['delta', 'reason', 'occurredAt', 'idempotencyKey']))
    const idempotencyKey = requiredId(body.idempotencyKey)
    const identity = createHash('sha256').update(`${actorUserId(ctx)}\0${idempotencyKey}`).digest('hex')
    const result = withStore(store => store.adjustInventory({
      id: `ledger:api:${identity.slice(0, 32)}`, itemId, delta: requiredNonZeroNumber(body.delta),
      reason: requiredText(body.reason, 200), source: 'home-api', sourceId: `home-api:${identity}`,
      occurredAt: requiredTimestamp(body.occurredAt),
    }))
    ctx.status = result.disposition === 'applied' ? 201 : 200
    return { disposition: result.disposition, item: { ...result.item,
      attributes: publicJsonObject(result.item.attributes) }, entry: result.entry }
  })
}

/** @openapi-response HomeDeviceListResponse */
export async function devices(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['spaceId', 'deviceClass', 'limit']))
    const spaceId = queryId(ctx, 'spaceId')
    const deviceClass = queryText(ctx, 'deviceClass', 100)
    const limit = queryInteger(ctx, 'limit', 1, 200)
    return { devices: withStore(store => store.listDevices({
      ...(spaceId === undefined ? {} : { spaceId }),
      ...(deviceClass === undefined ? {} : { deviceClass }),
      ...(limit === undefined ? {} : { limit }),
    }).map(device => publicDevice(store, device))) }
  })
}

/** @openapi-response HomeBindingListResponse */
export async function bindings(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['deviceId', 'provider', 'limit']))
    const deviceId = queryId(ctx, 'deviceId')
    const provider = queryEnum(ctx, 'provider', [PROVIDER] as const)
    const limit = queryInteger(ctx, 'limit', 1, 200)
    return { bindings: withStore(store => store.listBindings({
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(provider === undefined ? {} : { provider }),
      ...(limit === undefined ? {} : { limit }),
    })).map(publicBinding) }
  })
}

/** @openapi-response HomeProviderResponse */
export async function providerHealth(ctx: Context): Promise<void> {
  await respond(ctx, async () => { noQuery(ctx); return { provider: publicProviderStatus() } })
}

/** @openapi-response HomeActionResponse */
export async function refreshDevice(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const deviceId = pathId(ctx)
    const body = exactBody(ctx, new Set(['bindingId', 'externalId', 'requestedAt', 'idempotencyKey']))
    const bindingId = requiredId(body.bindingId)
    const externalId = requiredExternalId(body.externalId)
    await reconcileHomeProductionRuntime()
    withStore(store => {
      const binding = requireBinding(store, deviceId, bindingId, externalId)
      assertBindingCapabilityAllowed('home.device.refresh', externalId, binding.metadata)
      refreshHomeManagerAuthorization(store)
    })
    const result = createFabricIntent({
      capabilityId: 'home.device.refresh', requestedByRoleId: 'home-manager',
      requestedByUserId: actorUserId(ctx), idempotencyKey: requiredId(body.idempotencyKey),
      goal: 'Refresh one exact Home Assistant entity',
      target: { kind: 'home_device', provider: PROVIDER, deviceId, bindingId, externalId },
      input: { schemaVersion: 1, provider: PROVIDER, deviceId, bindingId, externalId,
        requestedAt: requiredTimestamp(body.requestedAt) },
      constraints: {}, rationale: 'Explicit authenticated home state refresh', environments: ['production'],
    })
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response HomeActionResponse */
export async function commandDevice(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const deviceId = pathId(ctx)
    const body = exactBody(ctx, new Set(['command', 'bindingId', 'externalId', 'expectedStateVersion',
      'verificationTimeoutMs', 'desiredPower', 'desiredLevel', 'desiredTemperatureC', 'idempotencyKey']))
    const command = requiredEnum(body.command, ['set_power', 'set_level', 'set_temperature'] as const)
    const capabilityId = `home.device.${command}` as 'home.device.set_power' | 'home.device.set_level'
      | 'home.device.set_temperature'
    const bindingId = requiredId(body.bindingId)
    const externalId = requiredExternalId(body.externalId)
    const expectedStateVersion = requiredInteger(body.expectedStateVersion, 0, Number.MAX_SAFE_INTEGER)
    const verificationTimeoutMs = requiredInteger(body.verificationTimeoutMs, 1_000, 120_000)
    const desired = desiredCommandInput(command, body)
    await reconcileHomeProductionRuntime()
    withStore(store => {
      const binding = requireBinding(store, deviceId, bindingId, externalId)
      assertBindingCapabilityAllowed(capabilityId, externalId, binding.metadata)
      const requiredCapability = command === 'set_power' ? 'power' : command === 'set_level' ? 'level' : 'temperature'
      if (!binding.capabilities.includes(requiredCapability)) throw new HomeRequestError('Binding capability unavailable')
      refreshHomeManagerAuthorization(store)
    })
    const result = createFabricIntent({
      capabilityId, requestedByRoleId: 'home-manager', requestedByUserId: actorUserId(ctx),
      idempotencyKey: requiredId(body.idempotencyKey), goal: 'Apply one exact approved home device command',
      target: { kind: 'home_device', provider: PROVIDER, deviceId, bindingId, externalId },
      input: { schemaVersion: 1, provider: PROVIDER, deviceId, bindingId, externalId,
        expectedStateVersion, verificationTimeoutMs, ...desired }, constraints: {},
      rationale: 'Explicit authenticated home command request', environments: ['production'],
    })
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response HomeActionResponse */
export async function activateScene(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const sceneId = pathId(ctx)
    const body = exactBody(ctx, new Set(['bindingId', 'externalId', 'verificationTimeoutMs', 'idempotencyKey']))
    const bindingId = requiredId(body.bindingId)
    const externalId = requiredExternalId(body.externalId)
    const verificationTimeoutMs = requiredInteger(body.verificationTimeoutMs, 1_000, 120_000)
    await reconcileHomeProductionRuntime()
    withStore(store => {
      const binding = requireBinding(store, sceneId, bindingId, externalId)
      assertBindingCapabilityAllowed('home.scene.activate.safe', externalId, binding.metadata)
      refreshHomeManagerAuthorization(store)
    })
    const result = createFabricIntent({
      capabilityId: 'home.scene.activate.safe', requestedByRoleId: 'home-manager',
      requestedByUserId: actorUserId(ctx), idempotencyKey: requiredId(body.idempotencyKey),
      goal: 'Activate one exact safe home scene',
      target: { kind: 'home_scene', provider: PROVIDER, sceneId, bindingId, externalId },
      input: { schemaVersion: 1, provider: PROVIDER, sceneId, bindingId, externalId,
        safeScene: true, verificationTimeoutMs }, constraints: {},
      rationale: 'Explicit authenticated safe scene request', environments: ['production'],
    })
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response HomeWorkflowResponse */
export async function workflow(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    return { workflow: publicHomeWorkflow(requireHomeWorkflow(ctx, pathId(ctx))) }
  })
}

/** @openapi-response HomeWorkflowResponse */
export async function reviewWorkflow(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const id = pathId(ctx)
    const body = exactBody(ctx, new Set(['action', 'reason']))
    const action = requiredEnum(body.action, ['approve', 'reject'] as const)
    requireHomeWorkflow(ctx, id)
    const actor = actorUserId(ctx)
    const reviewed = action === 'approve'
      ? approveFabricWorkflow(id, actor)
      : rejectFabricWorkflow(id, actor, requiredText(body.reason, 2_000))
    return { workflow: publicHomeWorkflow(reviewed) }
  })
}

function withStore<T>(operation: (store: HomeTwinStore) => T): T {
  return withPersonalTwinDb(db => operation(new HomeTwinStore(db)))
}

function requireBinding(store: HomeTwinStore, deviceId: string, bindingId: string, externalId: string) {
  const binding = store.getBinding(bindingId)
  if (!binding || binding.provider !== PROVIDER || binding.deviceId !== deviceId || binding.externalId !== externalId) {
    throw coded('HOME_BINDING_NOT_FOUND')
  }
  return binding
}

function assertBindingCapabilityAllowed(
  capabilityId: string,
  externalId: string,
  metadata: Record<string, unknown>,
): void {
  try { assertHomeCapabilityBindingAllowed(capabilityId, externalId, metadata) }
  catch { throw new HomeRequestError('Home binding capability is not allowed') }
}

function desiredCommandInput(command: 'set_power' | 'set_level' | 'set_temperature', body: Record<string, unknown>) {
  if (command === 'set_power') {
    if (typeof body.desiredPower !== 'boolean' || body.desiredLevel !== undefined
      || body.desiredTemperatureC !== undefined) throw new HomeRequestError('Invalid power command')
    return { desiredPower: body.desiredPower }
  }
  if (command === 'set_level') {
    if (body.desiredPower !== undefined || body.desiredTemperatureC !== undefined) throw new HomeRequestError('Invalid level command')
    return { desiredLevel: requiredNumber(body.desiredLevel, 0, 100) }
  }
  if (body.desiredPower !== undefined || body.desiredLevel !== undefined) throw new HomeRequestError('Invalid temperature command')
  return { desiredTemperatureC: requiredNumber(body.desiredTemperatureC, 5, 35) }
}

function publicProviderStatus() {
  const status = getHomeProductionRuntimeStatus()
  return { provider: PROVIDER, profile: status.profile, active: status.active, configured: status.configured,
    connectionStatus: status.connectionStatus, executorEnabled: status.executorEnabled,
    authorizedTargetCount: status.authorizedTargetCount, lastErrorCode: status.lastErrorCode }
}

function publicDevice(store: HomeTwinStore, device: ReturnType<HomeTwinStore['listDevices']>[number]) {
  return { ...device, attributes: publicJsonObject(device.attributes),
    bindings: store.listBindings({ deviceId: device.id, limit: 50 }).map(publicBinding),
    states: store.listDeviceStates({ deviceId: device.id, limit: 100 }).map(state => ({ ...state })) }
}

function publicBinding(binding: ReturnType<HomeTwinStore['listBindings']>[number]) {
  return { id: binding.id, deviceId: binding.deviceId, provider: binding.provider,
    externalId: binding.externalId, capabilities: [...binding.capabilities], version: binding.version,
    createdAt: binding.createdAt, updatedAt: binding.updatedAt }
}

function publicAction(result: ReturnType<typeof createFabricIntent>) {
  return { intent: { id: result.intent.id, capabilityId: result.intent.capabilityId },
    policyDecision: { id: result.policyDecision.id, outcome: result.policyDecision.outcome,
      reasonCodes: [...result.policyDecision.reasonCodes] },
    workflow: publicWorkflowBase(result.workflow) }
}

function publicHomeWorkflow(value: FabricWorkflowDetail) {
  return { ...publicWorkflowBase(value), capabilityId: value.capabilityId,
    policyDecision: value.policyDecision ? { id: value.policyDecision.id, outcome: value.policyDecision.outcome,
      reasonCodes: [...value.policyDecision.reasonCodes] } : null,
    steps: value.steps.map(step => ({ kind: step.kind, state: step.state, attempt: step.attempt,
      lastErrorCode: step.lastErrorCode, output: step.output, updatedAt: step.updatedAt })) }
}

function publicWorkflowBase(value: ReturnType<typeof createFabricIntent>['workflow'] | FabricWorkflowDetail) {
  return { id: value.id, state: value.state, version: value.version, attempt: value.attempt,
    lastErrorCode: value.lastErrorCode, availableActions: { ...value.availableActions },
    createdAt: value.createdAt, updatedAt: value.updatedAt, completedAt: value.completedAt }
}

function requireHomeWorkflow(ctx: Context, id: string): FabricWorkflowDetail {
  const value = getFabricWorkflow(id)
  if (!value || !value.capabilityId.startsWith('home.')) throw coded('HOME_WORKFLOW_NOT_FOUND')
  if (ctx.state.user?.role !== 'super_admin' && value.requestedByUserId !== actorUserId(ctx)) {
    throw coded('HOME_WORKFLOW_NOT_FOUND')
  }
  return value
}

async function respond(ctx: Context, operation: () => unknown | Promise<unknown>): Promise<void> {
  try { ctx.body = await operation() } catch (error) { mapError(ctx, error) }
}

function mapError(ctx: Context, error: unknown): void {
  if (error instanceof HomeRequestError || error instanceof HomeValidationError) {
    ctx.status = 400; ctx.body = { error: 'Invalid home request', code: 'HOME_REQUEST_INVALID' }; return
  }
  if (error instanceof HomeVersionConflictError || error instanceof HomeIdentityConflictError) {
    ctx.status = 409; ctx.body = { error: 'Home state conflict', code: 'HOME_STATE_CONFLICT' }; return
  }
  if (error instanceof HomeRecordNotFoundError) {
    ctx.status = 404; ctx.body = { error: 'Home record not found', code: 'HOME_RECORD_NOT_FOUND' }; return
  }
  const raw = error instanceof Error ? error.message : ''
  const code = /^HOME_[A-Z0-9_]{2,100}$/.test(raw) ? raw
    : /^FABRIC_[A-Z0-9_]{2,100}$/.test(raw) ? `HOME_${raw}` : 'HOME_API_OPERATION_FAILED'
  ctx.status = code.endsWith('_NOT_FOUND') ? 404 : code.includes('CONFLICT') || code.includes('STALE') ? 409 : 503
  ctx.body = { error: 'Home operation failed', code }
}

function exactBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') throw new HomeRequestError('JSON required')
  assertSafeGraph(request.body)
  if (!plain(request.body)) throw new HomeRequestError('JSON object required')
  if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_JSON_BYTES) throw new HomeRequestError('Body too large')
  if (Object.keys(request.body).some(key => !allowed.has(key) || SENSITIVE_KEY.test(key))) {
    throw new HomeRequestError('Unexpected request field')
  }
  return request.body
}

function assertSafeGraph(value: unknown): void {
  const seen = new Set<object>(); let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 1_024 || depth > 8) throw new HomeRequestError('Invalid request graph')
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))) return
    if (!item || typeof item !== 'object' || isProxy(item) || seen.has(item)) throw new HomeRequestError('Invalid request graph')
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new HomeRequestError('Invalid request graph')
    }
    seen.add(item)
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || POISON_KEYS.has(key) || SENSITIVE_KEY.test(key)) throw new HomeRequestError('Invalid request graph')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !('value' in descriptor)) throw new HomeRequestError('Invalid request graph')
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!plain(value)) throw new HomeRequestError('Invalid object')
  return value
}

function publicJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new HomeRequestError('Invalid identifier')
  return value
}

function nullableId(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredId(value)
}

function requiredExternalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,64}\.[a-z0-9_]{1,190}$/.test(value)) {
    throw new HomeRequestError('Invalid external identifier')
  }
  return value
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HomeRequestError('Invalid text')
  }
  return value
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new HomeRequestError('Invalid enum')
  return value as T
}

function requiredInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new HomeRequestError('Invalid integer')
  return Number(value)
}

function requiredNumber(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HomeRequestError('Invalid number')
  }
  return value
}

function nullableNumber(value: unknown, minimum: number): number | null {
  return value === null ? null : requiredNumber(value, minimum)
}

function requiredNonZeroNumber(value: unknown): number {
  const result = requiredNumber(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  if (result === 0) throw new HomeRequestError('Invalid delta')
  return result
}

function requiredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new HomeRequestError('Invalid timestamp')
  }
  return new Date(Date.parse(value)).toISOString()
}

function actorUserId(ctx: Context): string {
  const id = ctx.state.user?.id
  if ((typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) && typeof id !== 'string') {
    throw coded('HOME_ACTOR_UNAVAILABLE')
  }
  return requiredId(String(id))
}

function pathId(ctx: Context): string {
  let value = String(ctx.params.id ?? '')
  try { value = decodeURIComponent(value) } catch { throw new HomeRequestError('Invalid path identifier') }
  return requiredId(value)
}

function noQuery(ctx: Context): void { queryKeys(ctx, new Set()) }

function queryKeys(ctx: Context, allowed: ReadonlySet<string>): void {
  if (!plain(ctx.query) || Object.keys(ctx.query).some(key => !allowed.has(key))) throw new HomeRequestError('Invalid query')
}

function queryId(ctx: Context, key: string): string | undefined {
  const value = ctx.query[key]
  return value === undefined ? undefined : requiredId(value)
}

function queryText(ctx: Context, key: string, maximum: number): string | undefined {
  const value = ctx.query[key]
  return value === undefined ? undefined : requiredText(value, maximum)
}

function queryEnum<T extends string>(ctx: Context, key: string, allowed: readonly T[]): T | undefined {
  const value = ctx.query[key]
  return value === undefined ? undefined : requiredEnum(value, allowed)
}

function queryInteger(ctx: Context, key: string, minimum: number, maximum: number): number | undefined {
  const value = ctx.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new HomeRequestError('Invalid query integer')
  return requiredInteger(Number(value), minimum, maximum)
}

function queryBoolean(ctx: Context, key: string): boolean | undefined {
  const value = ctx.query[key]
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new HomeRequestError('Invalid query boolean')
}

function coded(code: string): Error { return new Error(code) }
