import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanDeviceInfo } from '../../packages/server/src/services/lan-discovery'

describe('devices store', () => {
  let db: any = null

  const device: LanDeviceInfo = {
    id: 'hwui_device_1',
    device_id: 'hwui_device_1',
    device_public_key: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
    computer_name: 'device-a',
    endpoint_kind: 'web',
    ip: '192.168.1.20',
    http_port: 8648,
    url: 'http://192.168.1.20:8648',
    os: {
      type: 'Linux',
      platform: 'linux',
      release: '1',
      arch: 'x64',
    },
    hermes_agent_version: 'v1',
    hermes_web_ui_version: '1',
    response_ms: 12,
    last_seen_at: new Date().toISOString(),
  }

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

  it('keeps inbound requests independent from outbound pairing state', async () => {
    const {
      getDeviceRelation,
      requestInboundDeviceLink,
      updateInboundStatus,
    } = await import('../../packages/server/src/db/hermes/devices-store')

    requestInboundDeviceLink(device)
    expect(getDeviceRelation(device.id)).toMatchObject({
      inbound_status: 'pending',
      outbound_status: 'none',
    })

    updateInboundStatus(device.id, 'approved')
    expect(getDeviceRelation(device.id)).toMatchObject({
      inbound_status: 'approved',
      outbound_status: 'none',
    })
  })

  it('rejects duplicate inbound requests while one is pending', async () => {
    const {
      DuplicateDeviceRequestError,
      getDeviceRelation,
      requestInboundDeviceLink,
    } = await import('../../packages/server/src/db/hermes/devices-store')

    requestInboundDeviceLink(device)
    expect(() => requestInboundDeviceLink(device)).toThrow(DuplicateDeviceRequestError)
    expect(getDeviceRelation(device.id)).toMatchObject({
      inbound_status: 'pending',
      outbound_status: 'none',
    })
  })
})
