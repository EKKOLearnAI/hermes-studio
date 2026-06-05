import { readFileSync } from 'fs'
import { createHash, generateKeyPairSync } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoveryPortForHttpPort,
  getDiscoveryHttpPorts,
  getLanEndpointKind,
  isPrivateOrLoopbackIPv4,
  resetLanDiscoveryState,
  scanLanDevices,
  startLanDiscoveryResponder,
} from '../../packages/server/src/services/lan-discovery'
import type { PublicSystemInfo } from '../../packages/server/src/services/system-info'

const fakeKeyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const fakeDeviceId = `hwui_${createHash('sha256').update(fakeKeyPair.publicKey).digest('base64url').slice(0, 32)}`

const fakeInfo: PublicSystemInfo = {
  device_id: fakeDeviceId,
  device_public_key: fakeKeyPair.publicKey,
  computer_name: 'test-machine',
  os: {
    type: 'TestOS',
    platform: 'linux',
    release: '1.0.0',
    arch: 'x64',
  },
  hermes_agent_version: 'v1.2.3',
  hermes_web_ui_version: '9.9.9',
}

describe('LAN discovery', () => {
  const originalPorts = process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS

  afterEach(() => {
    resetLanDiscoveryState()
    if (originalPorts === undefined) delete process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS
    else process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS = originalPorts
  })

  it('maps HTTP ports to UDP discovery ports', () => {
    expect(discoveryPortForHttpPort(8648)).toBe(48648)
    expect(discoveryPortForHttpPort(8748)).toBe(48748)
  })

  it('classifies well-known LAN endpoints', () => {
    expect(getLanEndpointKind(8648)).toBe('web')
    expect(getLanEndpointKind(8748)).toBe('desktop')
    expect(getLanEndpointKind(19001)).toBe('custom')
  })

  it('limits discovery responses to local/private IPv4 senders', () => {
    expect(isPrivateOrLoopbackIPv4('127.0.0.1')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('192.168.1.20')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('10.1.2.3')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateOrLoopbackIPv4('8.8.8.8')).toBe(false)
  })

  it('uses configured scan ports plus the active server port', () => {
    process.env.HERMES_LAN_DISCOVERY_HTTP_PORTS = '8648, 8748'

    expect(getDiscoveryHttpPorts(9999)).toEqual([8648, 8748, 9999])
  })

  it('discovers a local responder over UDP', async () => {
    const httpPort = 19001
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
      includeSelf: true,
    })

    expect(result.scanning).toBe(false)
    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]).toMatchObject({
      id: fakeDeviceId,
      device_id: fakeDeviceId,
      ip: '127.0.0.1',
      http_port: httpPort,
      url: `http://127.0.0.1:${httpPort}`,
      endpoint_kind: 'custom',
      computer_name: 'test-machine',
      hermes_agent_version: 'v1.2.3',
      hermes_web_ui_version: '9.9.9',
    })
  })

  it('builds device URLs from the UDP source address instead of announced URLs', async () => {
    const httpPort = 19003
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const originalSend = socket.send.bind(socket)
    socket.send = ((message: any, port: any, address: any, callback?: any) => {
      const announced = JSON.parse(Buffer.from(message).toString('utf8'))
      announced.url = 'http://127.0.0.1:1'
      return originalSend(Buffer.from(JSON.stringify(announced)), port, address, callback)
    }) as typeof socket.send

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
      includeSelf: true,
    })

    expect(result.devices).toHaveLength(1)
    expect(result.devices[0].url).toBe(`http://127.0.0.1:${httpPort}`)
  })

  it('excludes the local machine from scan results by default', async () => {
    const httpPort = 19002
    const socket = startLanDiscoveryResponder({
      httpPort,
      getSystemInfo: async () => fakeInfo,
    })
    if (!socket) throw new Error('expected discovery responder socket')
    await new Promise<void>(resolve => socket.once('listening', () => resolve()))

    const result = await scanLanDevices({
      httpPorts: [httpPort],
      targetAddresses: ['127.0.0.1'],
      timeoutMs: 300,
    })

    expect(result.scanning).toBe(false)
    expect(result.devices).toEqual([])
  })

  it('registers device request routes before auth and management routes behind auth', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    const deviceRoutesSource = readFileSync('packages/server/src/routes/devices.ts', 'utf8')
    const bootstrapSource = readFileSync('packages/server/src/index.ts', 'utf8')

    const authIndex = source.indexOf('authMiddleware.forEach')
    const publicDeviceIndex = source.indexOf('app.use(devicePublicRoutes.routes())')
    const deviceIndex = source.indexOf('app.use(deviceRoutes.routes())')

    expect(authIndex).toBeGreaterThanOrEqual(0)
    expect(publicDeviceIndex).toBeGreaterThanOrEqual(0)
    expect(deviceIndex).toBeGreaterThanOrEqual(0)
    expect(deviceRoutesSource).toContain("devicePublicRoutes.post('/api/devices/link-status'")
    expect(deviceRoutesSource).toContain("deviceRoutes.delete('/api/devices/:id/request-history'")
    expect(deviceRoutesSource).toContain("deviceRoutes.get('/api/devices/peer-connections'")
    expect(deviceRoutesSource).toContain("deviceRoutes.post('/api/devices/:id/connect'")
    expect(bootstrapSource).toContain('getLanPeerSocketPath()')
    expect(publicDeviceIndex).toBeLessThan(authIndex)
    expect(deviceIndex).toBeGreaterThan(authIndex)
  })
})
