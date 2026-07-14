import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  listFabricExecutors,
  setFabricExecutorEnabled,
  updateFabricExecutorHealth,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  HomeTwinStore,
  clearHomeManagerAuthorization,
  refreshHomeManagerAuthorization,
} from '../../packages/server/src/services/hermes/home'
import { getPersonalTwinDbPath, initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin/database'

describe('home production authorization', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''
  let database: DatabaseSync | null = null
  let store: HomeTwinStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-home-authorization-'))
    process.env.HERMES_HOME = directory
    const path = getPersonalTwinDbPath()
    mkdirSync(join(path, '..'), { recursive: true })
    database = new DatabaseSync(path)
    database.exec('PRAGMA foreign_keys = ON')
    initPersonalTwinSchema(database)
    store = new HomeTwinStore(database)
    ensureBuiltInFabricRegistry()
    setFabricExecutorEnabled('home-assistant', true)
    updateFabricExecutorHealth('home-assistant', 'healthy', { connectionStatus: 'connected' })
  })

  afterEach(() => {
    database?.close()
    database = null
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('allows refresh, requires approval for writes, and keeps repeat evaluations stable', () => {
    addLightBinding()
    expect(refreshHomeManagerAuthorization(store)).toEqual([
      'home:binding:home-assistant:light.office_lamp',
      'home:device:device:lamp',
      'home:provider:home-assistant',
    ])

    const refresh = evaluateFabricPolicy({
      capabilityId: 'home.device.refresh', requestedByRoleId: 'home-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'home-refresh-1', target: target(), input: {
        schemaVersion: 1, provider: 'home-assistant', deviceId: 'device:lamp', bindingId: 'binding:lamp',
        externalId: 'light.office_lamp', requestedAt: '2026-07-15T01:00:00.000Z',
      }, constraints: {},
    })
    expect(refresh).toMatchObject({ outcome: 'allow', executorId: 'home-assistant', reasonCodes: [] })

    const writeInput = {
      capabilityId: 'home.device.set_power', requestedByRoleId: 'home-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'home-power-1', target: target(), input: {
        schemaVersion: 1, provider: 'home-assistant', deviceId: 'device:lamp', bindingId: 'binding:lamp',
        externalId: 'light.office_lamp', expectedStateVersion: 1, verificationTimeoutMs: 30_000,
        desiredPower: true,
      }, constraints: {},
    } as const
    const first = evaluateFabricPolicy(writeInput)
    const repeated = evaluateFabricPolicy(writeInput)
    expect(first).toMatchObject({ outcome: 'waiting_user', executorId: 'home-assistant' })
    expect(first.reasonCodes).toContain('irreversible_requires_approval')
    expect(repeated.id).toBe(first.id)
    expect(repeated.materialInputDigest).toBe(first.materialInputDigest)
  })

  it('denies non-exact targets, cleared authorization, and unavailable production providers', () => {
    addLightBinding()
    refreshHomeManagerAuthorization(store)
    const input = {
      capabilityId: 'home.device.set_power', requestedByRoleId: 'home-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'home-denied-target', target: { ...target(), externalId: 'light.other' }, input: {
        schemaVersion: 1, provider: 'home-assistant', deviceId: 'device:lamp', bindingId: 'binding:lamp',
        externalId: 'light.office_lamp', expectedStateVersion: 1, verificationTimeoutMs: 30_000,
        desiredPower: false,
      }, constraints: {},
    } as const
    expect(evaluateFabricPolicy(input)).toMatchObject({ outcome: 'deny', reasonCodes: ['target_not_allowed'] })

    clearHomeManagerAuthorization()
    expect(evaluateFabricPolicy({ ...input, idempotencyKey: 'home-cleared', target: target() }))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['target_not_allowed'] })

    setFabricExecutorEnabled('home-assistant', false)
    expect(evaluateFabricPolicy({ ...input, idempotencyKey: 'home-unavailable', target: target() }))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['executor_unavailable'] })
    expect(listFabricExecutors().find(item => item.id === 'home-assistant')?.enabled).toBe(false)
  })

  it('authorizes a safe scene as an exact scene target without granting a device target', () => {
    store.upsertDevice({ id: 'scene:evening', name: 'Evening', deviceClass: 'scene', availability: 'available',
      expectedVersion: 0 })
    store.upsertBinding({ id: 'binding:scene', deviceId: 'scene:evening', provider: 'home-assistant',
      externalId: 'scene.evening', capabilities: [], metadata: { entityDomain: 'scene', safeScene: true },
      expectedVersion: 0 })
    expect(refreshHomeManagerAuthorization(store)).toEqual([
      'home:binding:home-assistant:scene.evening',
      'home:provider:home-assistant',
      'home:scene:scene:evening',
    ])
    expect(evaluateFabricPolicy({
      capabilityId: 'home.scene.activate.safe', requestedByRoleId: 'home-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'home-scene-safe', target: {
        kind: 'home_scene', provider: 'home-assistant', sceneId: 'scene:evening',
        bindingId: 'binding:scene', externalId: 'scene.evening',
      }, input: {
        schemaVersion: 1, provider: 'home-assistant', sceneId: 'scene:evening', bindingId: 'binding:scene',
        externalId: 'scene.evening', safeScene: true, verificationTimeoutMs: 30_000,
      }, constraints: {},
    })).toMatchObject({ outcome: 'waiting_user', executorId: 'home-assistant' })
  })

  function addLightBinding(): void {
    store.upsertDevice({ id: 'device:lamp', name: 'Office lamp', deviceClass: 'light', availability: 'available',
      expectedVersion: 0 })
    store.upsertBinding({ id: 'binding:lamp', deviceId: 'device:lamp', provider: 'home-assistant',
      externalId: 'light.office_lamp', capabilities: ['level', 'power'], metadata: { entityDomain: 'light' },
      expectedVersion: 0 })
  }
})

function target() {
  return { kind: 'home_device', provider: 'home-assistant', deviceId: 'device:lamp',
    bindingId: 'binding:lamp', externalId: 'light.office_lamp' }
}
