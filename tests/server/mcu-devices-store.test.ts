import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('MCU devices store', () => {
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

  it('stores official and unofficial MCU devices', async () => {
    const { createMcuDevice, listMcuDevices } = await import('../../packages/server/src/db/hermes/mcu-devices-store')

    const official = createMcuDevice({
      name: 'Official Box',
      deviceCode: 'official-code',
      isOfficial: true,
    })
    const unofficial = createMcuDevice({
      name: 'Unofficial Box',
      deviceCode: 'unofficial-code',
      isOfficial: false,
    })

    expect(official.is_official).toBe(true)
    expect(unofficial.is_official).toBe(false)
    expect(listMcuDevices().map(device => device.device_code).sort()).toEqual(['official-code', 'unofficial-code'])
  })

  it('rejects duplicate device codes', async () => {
    const { createMcuDevice } = await import('../../packages/server/src/db/hermes/mcu-devices-store')

    createMcuDevice({
      name: 'Box',
      deviceCode: 'duplicate-code',
      isOfficial: true,
    })

    expect(() => createMcuDevice({
      name: 'Box 2',
      deviceCode: 'duplicate-code',
      isOfficial: false,
    })).toThrow('mcu_device_exists')
  })

  it('updates device name only', async () => {
    const { createMcuDevice, updateMcuDeviceName } = await import('../../packages/server/src/db/hermes/mcu-devices-store')

    const created = createMcuDevice({
      name: 'Old Name',
      deviceCode: 'editable-code',
      isOfficial: true,
    })
    const updated = updateMcuDeviceName(created.id, 'New Name')

    expect(updated.name).toBe('New Name')
    expect(updated.device_code).toBe('editable-code')
    expect(updated.is_official).toBe(true)
  })

  it('deletes MCU devices', async () => {
    const { createMcuDevice, deleteMcuDevice, listMcuDevices } = await import('../../packages/server/src/db/hermes/mcu-devices-store')

    const created = createMcuDevice({
      name: 'Delete Me',
      deviceCode: 'delete-code',
      isOfficial: false,
    })

    expect(deleteMcuDevice(created.id)).toBe(true)
    expect(deleteMcuDevice(created.id)).toBe(false)
    expect(listMcuDevices()).toEqual([])
  })
})
