import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeTwinStore } from '../../packages/server/src/services/hermes/home/store'
import { withPersonalTwinDb } from '../../packages/server/src/services/hermes/personal-twin/database'

const fabric = vi.hoisted(() => ({
  createFabricIntent: vi.fn(), getFabricWorkflow: vi.fn(), listFabricWorkflows: vi.fn(),
  approveFabricWorkflow: vi.fn(), rejectFabricWorkflow: vi.fn(),
}))
const production = vi.hoisted(() => ({
  reconcileHomeProductionRuntime: vi.fn(async () => {}),
  getHomeProductionRuntimeStatus: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric', () => fabric)
vi.mock('../../packages/server/src/services/hermes/home/production-runtime', () => production)

describe('home controller', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-home-controller-'))
    process.env.HERMES_HOME = directory
    vi.clearAllMocks()
    production.getHomeProductionRuntimeStatus.mockReturnValue({
      active: true, profile: 'default', configured: true, credentialFingerprint: 'must-not-leak',
      connectionStatus: 'connected', executorEnabled: true, authorizedTargetCount: 3, lastErrorCode: null,
    })
    fabric.listFabricWorkflows.mockReturnValue([])
    fabric.createFabricIntent.mockReturnValue(actionResult())
    fabric.getFabricWorkflow.mockReturnValue(workflowDetail())
    fabric.approveFabricWorkflow.mockReturnValue(workflowDetail({ state: 'preparing' }))
    fabric.rejectFabricWorkflow.mockReturnValue(workflowDetail({ state: 'cancelled' }))
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('serves bounded overview and provider health without credential material', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const overview = context()
    await ctrl.overview(overview)
    expect(overview.body).toMatchObject({ provider: { configured: true, executorEnabled: true },
      summary: { spaceCount: 0, deviceCount: 0, activeWorkflowCount: 0 },
      overview: { profile: 'default', rooms: [], inventory: [], devices: [] } })
    const map = context(undefined, { query: { profile: 'default' } })
    await ctrl.legacyMap(map)
    expect(map.body).toMatchObject({ map: { profile: 'default', rooms: [], devices: [] } })
    const layout = context(undefined, { query: { profile: 'default' } })
    await ctrl.legacyLayout(layout)
    expect(layout.body.layout).toMatchObject({ version: 1, unit: 'cm' })
    const provider = context()
    await ctrl.providerHealth(provider)
    expect(JSON.stringify([overview.body, provider.body])).not.toMatch(/fingerprint|token|credential/i)
  })

  it('runs bounded explicit legacy imports and rejects malformed profile selection', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const imported = context({ profiles: ['default'] })
    await ctrl.importLegacy(imported)
    expect(imported.body).toMatchObject({ import: { status: 'completed', profiles: [], counts: { profiles: 0 } } })

    const duplicate = context({ profiles: ['default', 'default'] })
    await ctrl.importLegacy(duplicate)
    expect(duplicate).toMatchObject({ status: 400, body: { code: 'HOME_REQUEST_INVALID' } })

    const injected = context({ profiles: ['../private'] })
    await ctrl.importLegacy(injected)
    expect(injected).toMatchObject({ status: 400, body: { code: 'HOME_REQUEST_INVALID' } })
  })

  it('upserts spaces and inventory and keeps quantity changes on the idempotent ledger', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const space = context({ id: 'space:office', kind: 'room', name: 'Office', parentSpaceId: null,
      attributes: { floor: 2 }, expectedVersion: 0 })
    await ctrl.upsertSpace(space)
    expect(space.status).toBe(201)

    const item = context({ name: 'Filters', unit: 'piece', initialQuantity: 2, lowStockThreshold: 1,
      attributes: { model: 'A1' }, expectedVersion: 0 }, { id: 'inventory:filters' })
    await ctrl.upsertInventoryItem(item)
    expect(item.status).toBe(201)

    const adjustmentBody = { delta: -1, reason: 'Installed', occurredAt: '2026-07-15T02:00:00Z',
      idempotencyKey: 'adjust-filter-1' }
    const adjusted = context(adjustmentBody, { id: 'inventory:filters' })
    await ctrl.adjustInventory(adjusted)
    expect(adjusted.status).toBe(201)
    expect(adjusted.body).toMatchObject({ disposition: 'applied', item: { quantity: 1 } })
    const replay = context(adjustmentBody, { id: 'inventory:filters' })
    await ctrl.adjustInventory(replay)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ disposition: 'duplicate', item: { quantity: 1 } })

    const invalid = context({ ...adjustmentBody, service: 'switch.turn_on' }, { id: 'inventory:filters' })
    await ctrl.adjustInventory(invalid)
    expect(invalid).toMatchObject({ status: 400, body: { code: 'HOME_REQUEST_INVALID' } })
  })

  it('lists normalized devices and bindings without exposing provider metadata', async () => {
    seedLight()
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const devices = context(undefined, { query: { limit: '20' } })
    await ctrl.devices(devices)
    const bindings = context(undefined, { query: { provider: 'home-assistant' } })
    await ctrl.bindings(bindings)
    expect(devices.body.devices[0]).toMatchObject({ id: 'device:lamp', bindings: [
      { id: 'binding:lamp', externalId: 'light.office_lamp', capabilities: ['level', 'power'] },
    ] })
    expect(JSON.stringify([devices.body, bindings.body])).not.toMatch(/metadata|safeScene|token/i)
  })

  it('routes refresh and exact safe commands through Action Fabric and rejects command-surface injection', async () => {
    seedLight()
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const refresh = context({ bindingId: 'binding:lamp', externalId: 'light.office_lamp',
      requestedAt: '2026-07-15T02:00:00Z', idempotencyKey: 'refresh-lamp-1' }, { id: 'device:lamp' })
    await ctrl.refreshDevice(refresh)
    expect(refresh.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'home.device.refresh', requestedByUserId: '42', environments: ['production'],
    }))

    const command = context({ command: 'set_power', bindingId: 'binding:lamp', externalId: 'light.office_lamp',
      expectedStateVersion: 1, verificationTimeoutMs: 30_000, desiredPower: true,
      idempotencyKey: 'power-lamp-1' }, { id: 'device:lamp' })
    await ctrl.commandDevice(command)
    expect(command.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: 'home.device.set_power', input: expect.objectContaining({ desiredPower: true }),
      target: { kind: 'home_device', provider: 'home-assistant', deviceId: 'device:lamp',
        bindingId: 'binding:lamp', externalId: 'light.office_lamp' },
    }))

    const injected = context({ ...command.request.body, service_data: { entity_id: 'lock.front' } },
      { id: 'device:lamp' })
    await ctrl.commandDevice(injected)
    expect(injected.status).toBe(400)
    expect(fabric.createFabricIntent).toHaveBeenCalledTimes(2)

    seedDangerousLock()
    const dangerous = context({ command: 'set_power', bindingId: 'binding:lock', externalId: 'lock.front_door',
      expectedStateVersion: 0, verificationTimeoutMs: 30_000, desiredPower: true,
      idempotencyKey: 'unlock-front-1' }, { id: 'device:lock' })
    await ctrl.commandDevice(dangerous)
    expect(dangerous).toMatchObject({ status: 400, body: { code: 'HOME_REQUEST_INVALID' } })
    expect(fabric.createFabricIntent).toHaveBeenCalledTimes(2)
  })

  it('activates only safe scene bindings and reviews only Home workflows', async () => {
    seedScene()
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const scene = context({ bindingId: 'binding:scene', externalId: 'scene.evening',
      verificationTimeoutMs: 30_000, idempotencyKey: 'scene-evening-1' }, { id: 'scene:evening' })
    await ctrl.activateScene(scene)
    expect(scene.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'home.scene.activate.safe', input: expect.objectContaining({ safeScene: true }),
    }))

    const detail = context(undefined, { id: 'workflow:home-1' })
    await ctrl.workflow(detail)
    expect(detail.body.workflow).toMatchObject({ capabilityId: 'home.device.set_power', state: 'waiting_user' })
    expect(JSON.stringify(detail.body)).not.toMatch(/materialInputDigest|policySnapshot|executionToken/i)

    const review = context({ action: 'approve' }, { id: 'workflow:home-1' })
    await ctrl.reviewWorkflow(review)
    expect(fabric.approveFabricWorkflow).toHaveBeenCalledWith('workflow:home-1', '42')

    fabric.getFabricWorkflow.mockReturnValueOnce(workflowDetail({ capabilityId: 'health.plan.adjust' }))
    const foreign = context({ action: 'approve' }, { id: 'workflow:home-1' })
    await ctrl.reviewWorkflow(foreign)
    expect(foreign).toMatchObject({ status: 404, body: { code: 'HOME_WORKFLOW_NOT_FOUND' } })
  })

  it('sanitizes unexpected provider and database failures', async () => {
    seedLight()
    fabric.createFabricIntent.mockImplementationOnce(() => { throw new Error('sqlite C:\\Users\\alice token=secret') })
    const ctrl = await import('../../packages/server/src/controllers/hermes/home')
    const command = context({ command: 'set_power', bindingId: 'binding:lamp', externalId: 'light.office_lamp',
      expectedStateVersion: 1, verificationTimeoutMs: 30_000, desiredPower: false,
      idempotencyKey: 'power-failure-1' }, { id: 'device:lamp' })
    await ctrl.commandDevice(command)
    expect(command).toMatchObject({ status: 503, body: { code: 'HOME_API_OPERATION_FAILED' } })
    expect(JSON.stringify(command.body)).not.toMatch(/sqlite|alice|secret|token/i)
  })
})

function seedLight(): void {
  withPersonalTwinDb(db => {
    const store = new HomeTwinStore(db)
    store.upsertDevice({ id: 'device:lamp', name: 'Office lamp', deviceClass: 'light', availability: 'available',
      attributes: { entityDomain: 'light' }, expectedVersion: 0 })
    store.upsertBinding({ id: 'binding:lamp', deviceId: 'device:lamp', provider: 'home-assistant',
      externalId: 'light.office_lamp', capabilities: ['level', 'power'],
      metadata: { entityDomain: 'light' }, expectedVersion: 0 })
  })
}

function seedScene(): void {
  withPersonalTwinDb(db => {
    const store = new HomeTwinStore(db)
    store.upsertDevice({ id: 'scene:evening', name: 'Evening', deviceClass: 'scene', availability: 'available',
      expectedVersion: 0 })
    store.upsertBinding({ id: 'binding:scene', deviceId: 'scene:evening', provider: 'home-assistant',
      externalId: 'scene.evening', capabilities: [], metadata: { entityDomain: 'scene', safeScene: true },
      expectedVersion: 0 })
  })
}

function seedDangerousLock(): void {
  withPersonalTwinDb(db => {
    const store = new HomeTwinStore(db)
    store.upsertDevice({ id: 'device:lock', name: 'Front lock', deviceClass: 'lock', availability: 'available',
      expectedVersion: 0 })
    store.upsertBinding({ id: 'binding:lock', deviceId: 'device:lock', provider: 'home-assistant',
      externalId: 'lock.front_door', capabilities: ['power'], metadata: { entityDomain: 'lock' }, expectedVersion: 0 })
  })
}

function context(body?: unknown, options: { id?: string; role?: string; query?: Record<string, string> } = {}): any {
  return { params: { id: options.id ?? '' }, query: options.query ?? {}, request: { body, type: 'application/json' },
    state: { user: { id: 42, username: 'root', role: options.role ?? 'super_admin' } }, body: null, status: 200 }
}

function actionResult() {
  return { intent: { id: 'intent:home-1', capabilityId: 'home.device.set_power' },
    policyDecision: { id: 'decision:home-1', outcome: 'waiting_user', reasonCodes: ['irreversible_requires_approval'] },
    workflow: workflowBase() }
}

function workflowBase(overrides: Record<string, unknown> = {}) {
  return { id: 'workflow:home-1', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
    availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false },
    createdAt: '2026-07-15T02:00:00.000Z', updatedAt: '2026-07-15T02:00:00.000Z', completedAt: null,
    ...overrides }
}

function workflowDetail(overrides: Record<string, unknown> = {}) {
  return { ...workflowBase(), capabilityId: 'home.device.set_power', requestedByUserId: '42',
    policyDecision: { id: 'decision:home-1', outcome: 'waiting_user', reasonCodes: ['irreversible_requires_approval'] },
    steps: [{ kind: 'prepare', state: 'waiting_user', attempt: 0, lastErrorCode: null, output: null,
      updatedAt: '2026-07-15T02:00:00.000Z' }], ...overrides }
}
