import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('App connections store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('stores only a hash of each five-minute authorization code and consumes it once', async () => {
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')
    const issued = store.createAppAuthorizationCode(42, 1_000)
    const row = db.prepare('SELECT * FROM app_authorization_codes WHERE id = ?')
      .get(issued.record.id) as any

    expect(row.code_hash).toBe(store.hashAppCredential(issued.authorizationCode))
    expect(row.code_hash).not.toContain(issued.authorizationCode)
    expect(row.created_by_user_id).toBe(42)
    expect(row.expires_at).toBe(1_000 + 5 * 60)

    const consumed = store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-001', 1_100)
    expect(consumed.created_by_user_id).toBe(42)
    expect(consumed.used_by_device_code).toBe('phone-001')
    expect(() => store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-002', 1_101))
      .toThrow('app_authorization_code_used')
  })

  it('rejects expired authorization codes', async () => {
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')
    const issued = store.createAppAuthorizationCode(7, 2_000)

    expect(() => store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-001', 2_301))
      .toThrow('app_authorization_code_expired')
  })

  it('deduplicates by phone code and connection type and validates each bound token', async () => {
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')
    const first = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 16,1',
      connectionType: 'lan',
      userId: 7,
      token: 'first-token',
      tokenExpiresAt: 4_000,
      now: 3_000,
    })
    const updated = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone 16',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'lan',
      userId: 7,
      token: 'second-token',
      tokenExpiresAt: 5_000,
      now: 3_100,
    })

    expect(updated.id).toBe(first.id)
    expect(store.listAppConnections()).toHaveLength(1)
    expect(updated).toMatchObject({
      device_name: 'Alice iPhone 16',
      device_brand: 'Apple',
      device_model: 'iPhone 17,1',
      connection_type: 'lan',
      user_id: 7,
    })
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'first-token', 7, 3_200)).toBe(false)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 7, 3_200)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 8, 3_200)).toBe(false)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 7, 5_000)).toBe(false)

    const cloud = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone 16',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'cloud',
      userId: 7,
      token: 'cloud-token',
      tokenExpiresAt: 5_000,
      now: 3_200,
    })
    expect(cloud.id).not.toBe(updated.id)
    expect(store.listAppConnections()).toHaveLength(2)
    expect(store.isAppConnectionTokenActive('phone-001', 'cloud', 'cloud-token', 7, 3_300)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'cloud-token', 7, 3_300)).toBe(false)
  })

  it('hides revoked connections while retaining the tombstone for an offline App reconnect', async () => {
    const store = await import('../../packages/server/src/db/hermes/app-connections-store')
    const connection = store.upsertAppConnection({
      deviceCode: 'phone-offline',
      deviceName: 'Offline Phone',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'lan',
      userId: 7,
      token: 'offline-token',
      tokenExpiresAt: 5_000,
      now: 3_000,
    })

    expect(store.getAppConnectionTokenStatus('phone-offline', 'lan', 'offline-token', 7, 3_100)).toBe('active')
    expect(store.revokeAppConnection(connection.id, 3_200)).toMatchObject({
      id: connection.id,
      revoked_at: 3_200,
    })
    expect(store.listAppConnections()).toEqual([])
    expect(store.getAppConnectionTokenStatus('phone-offline', 'lan', 'offline-token', 7, 3_300)).toBe('revoked')
    expect(store.isAppConnectionTokenActive('phone-offline', 'lan', 'offline-token', 7, 3_300)).toBe(false)
    expect(store.revokeAppConnection(connection.id, 3_400)).toBeNull()
  })
})
