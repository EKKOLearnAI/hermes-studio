import { createHash, generateKeyPairSync, sign } from 'crypto'
import { createServer, type Server } from 'http'
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
    vi.unstubAllGlobals()
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

  it('rejects peer socket connections until outbound pairing is approved locally', async () => {
    vi.doMock('../../packages/server/src/services/lan-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/lan-discovery')>(
        '../../packages/server/src/services/lan-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [device],
        }),
      }
    })

    const { connectPeerDevice } = await import('../../packages/server/src/controllers/devices')
    const ctx: any = {
      params: { id: device.id },
      request: { body: {} },
    }

    await connectPeerDevice(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Device pairing has not been approved' })
  })

  it('records outbound status when requesting pairing from a device with inbound history', async () => {
    vi.doMock('../../packages/server/src/services/lan-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/lan-discovery')>(
        '../../packages/server/src/services/lan-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [device],
        }),
      }
    })
    vi.doMock('../../packages/server/src/services/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/system-info')>(
        '../../packages/server/src/services/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { requestInboundDeviceLink, updateInboundStatus, getDeviceRelation } = await import('../../packages/server/src/db/hermes/devices-store')
    requestInboundDeviceLink(device)
    updateInboundStatus(device.id, 'approved')

    const { requestDevicePairing } = await import('../../packages/server/src/controllers/devices')
    const ctx: any = {
      params: { id: device.id },
      request: { body: {} },
    }

    await requestDevicePairing(ctx)

    const relation = getDeviceRelation(device.id)
    expect(ctx.status).toBeUndefined()
    expect(relation?.inbound_status).toBe('approved')
    expect(relation?.outbound_status).toBe('pending')
    expect(relation?.outbound_requested_at).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.20:8648/api/devices/link-request',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('falls back to the native HTTP client when fetch cannot reach a LAN peer', async () => {
    let receivedRequest: any = null
    let server: Server | null = null

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        req.on('end', () => {
          if (req.url === '/api/devices/link-request') {
            receivedRequest = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'pending' }))
        })
      })
      server.listen(0, '127.0.0.1', resolve)
    })

    const address = server!.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const fallbackDevice: LanDeviceInfo = {
      ...device,
      ip: '127.0.0.1',
      http_port: port,
      url: `http://127.0.0.1:${port}`,
    }

    try {
      vi.doMock('../../packages/server/src/services/lan-discovery', async () => {
        const actual = await vi.importActual<typeof import('../../packages/server/src/services/lan-discovery')>(
          '../../packages/server/src/services/lan-discovery',
        )
        return {
          ...actual,
          getLanDiscoveryCache: () => ({
            scanning: false,
            last_scanned_at: new Date().toISOString(),
            devices: [fallbackDevice],
          }),
        }
      })
      vi.doMock('../../packages/server/src/services/system-info', async () => {
        const actual = await vi.importActual<typeof import('../../packages/server/src/services/system-info')>(
          '../../packages/server/src/services/system-info',
        )
        return {
          ...actual,
          getPublicSystemInfo: async () => ({
            device_id: 'hwui_local',
            device_public_key: keyPair.publicKey,
            computer_name: 'local',
            os: { type: 'TestOS', platform: 'darwin', release: '1', arch: 'arm64' },
            hermes_agent_version: 'v1',
            hermes_web_ui_version: '1',
          }),
          createDeviceSignature: async () => 'signature',
        }
      })

      const fetchMock = vi.fn(async () => {
        throw Object.assign(new Error(`connect EHOSTUNREACH ${fallbackDevice.ip}:${fallbackDevice.http_port}`), {
          code: 'EHOSTUNREACH',
          syscall: 'connect',
          address: fallbackDevice.ip,
          port: fallbackDevice.http_port,
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const { getDeviceRelation } = await import('../../packages/server/src/db/hermes/devices-store')
      const { requestDevicePairing } = await import('../../packages/server/src/controllers/devices')
      const ctx: any = {
        params: { id: fallbackDevice.id },
        request: { body: {} },
      }

      await requestDevicePairing(ctx)

      const relation = getDeviceRelation(fallbackDevice.id)
      expect(ctx.status).toBeUndefined()
      expect(relation?.outbound_status).toBe('pending')
      expect(receivedRequest).toEqual(expect.objectContaining({
        device_id: 'hwui_local',
        signature: 'signature',
      }))
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:${port}/api/devices/link-request`,
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server!.close(err => err ? reject(err) : resolve())
      })
    }
  })

  it('requests pairing from a manually entered remote URL', async () => {
    vi.doMock('../../packages/server/src/services/lan-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/lan-discovery')>(
        '../../packages/server/src/services/lan-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [],
        }),
      }
    })
    vi.doMock('../../packages/server/src/services/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/system-info')>(
        '../../packages/server/src/services/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === 'https://remote.example.com/api/devices/link-info') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_id: device.id,
            device_public_key: device.device_public_key,
            computer_name: 'remote-device',
            endpoint_kind: 'web',
            http_port: 443,
            os: { type: 'Linux', platform: 'linux', release: '1', arch: 'x64' },
            hermes_agent_version: 'v1',
            hermes_web_ui_version: '1',
          }),
        }
      }
      if (url === 'https://remote.example.com/api/devices/link-request' && options?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'pending' }),
        }
      }
      if (url === 'https://remote.example.com/api/devices/link-status' && options?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'pending' }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getDeviceRelation } = await import('../../packages/server/src/db/hermes/devices-store')
    const { requestManualDevicePairing } = await import('../../packages/server/src/controllers/devices')
    const ctx: any = {
      request: {
        body: {
          url: 'https://remote.example.com/some/path?ignored=true',
        },
      },
    }

    await requestManualDevicePairing(ctx)

    const relation = getDeviceRelation(device.id)
    expect(ctx.status).toBeUndefined()
    expect(relation?.outbound_status).toBe('pending')
    expect(relation?.url).toBe('https://remote.example.com')
    expect(ctx.body.devices).toEqual([
      expect.objectContaining({
        id: device.id,
        computer_name: 'remote-device',
        online: true,
        outbound_status: 'pending',
        url: 'https://remote.example.com',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-info',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-request',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps a manually paired remote device in the list when it is offline', async () => {
    vi.doMock('../../packages/server/src/services/lan-discovery', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/lan-discovery')>(
        '../../packages/server/src/services/lan-discovery',
      )
      return {
        ...actual,
        getLanDiscoveryCache: () => ({
          scanning: false,
          last_scanned_at: new Date().toISOString(),
          devices: [],
        }),
      }
    })
    vi.doMock('../../packages/server/src/services/system-info', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/services/system-info')>(
        '../../packages/server/src/services/system-info',
      )
      return {
        ...actual,
        getPublicSystemInfo: async () => ({
          device_id: 'hwui_local',
          device_public_key: keyPair.publicKey,
          computer_name: 'local',
          os: { type: 'TestOS', platform: 'linux', release: '1', arch: 'x64' },
          hermes_agent_version: 'v1',
          hermes_web_ui_version: '1',
        }),
        createDeviceSignature: async () => 'signature',
      }
    })

    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { updateOutboundStatus } = await import('../../packages/server/src/db/hermes/devices-store')
    const { listDevices } = await import('../../packages/server/src/controllers/devices')
    updateOutboundStatus(device.id, 'approved', {
      ...device,
      ip: 'remote.example.com',
      http_port: 443,
      url: 'https://remote.example.com',
    })

    const ctx: any = {}
    await listDevices(ctx)

    expect(ctx.body.devices).toEqual([
      expect.objectContaining({
        id: device.id,
        online: false,
        outbound_status: 'approved',
        url: 'https://remote.example.com',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.com/api/devices/link-status',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
