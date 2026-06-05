import { createHash, generateKeyPairSync, sign } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanDeviceInfo } from '../../packages/server/src/services/lan-discovery'

const keyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const deviceId = `hwui_${createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 32)}`

const device: LanDeviceInfo = {
  id: deviceId,
  device_id: deviceId,
  device_public_key: keyPair.publicKey,
  computer_name: 'paired-device',
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

describe('devices controller', () => {
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

  it('returns the inbound pairing status for a signed device status request', async () => {
    const { requestInboundDeviceLink, updateInboundStatus } = await import('../../packages/server/src/db/hermes/devices-store')
    requestInboundDeviceLink(device)
    updateInboundStatus(device.id, 'approved')

    const timestamp = Date.now()
    const nonce = 'status-nonce-1'
    const signature = sign(null, Buffer.from(`${device.id}.${nonce}.${timestamp}`), keyPair.privateKey).toString('base64url')
    const ctx: any = {
      request: {
        body: {
          device_id: device.id,
          device_public_key: device.device_public_key,
          timestamp,
          nonce,
          signature,
        },
      },
    }

    const { requestDeviceLinkStatusController } = await import('../../packages/server/src/controllers/devices')
    await requestDeviceLinkStatusController(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({ status: 'approved' })
  })
})
