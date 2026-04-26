import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startDeviceFlow,
  pollDeviceFlow,
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
} from '../../packages/server/src/services/hermes/copilot-device-flow'

function mockJsonResponse(data: any, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

describe('startDeviceFlow', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs client_id + scope and returns parsed device code', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({
      device_code: 'DC-1',
      user_code: 'USER-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }))
    const data = await startDeviceFlow(fetchSpy as any)
    expect(data.device_code).toBe('DC-1')
    expect(data.user_code).toBe('USER-1234')
    expect(data.verification_uri).toBe('https://github.com/login/device')
    expect(data.expires_in).toBe(900)
    expect(data.interval).toBe(5)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://github.com/login/device/code')
    expect(init.method).toBe('POST')
    const body = String(init.body)
    expect(body).toContain(`client_id=${encodeURIComponent(COPILOT_OAUTH_CLIENT_ID)}`)
    expect(body).toContain(`scope=${encodeURIComponent(COPILOT_OAUTH_SCOPE)}`)
  })

  it('throws on non-2xx status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => 'unavailable',
    })
    await expect(startDeviceFlow(fetchSpy as any)).rejects.toThrow(/503/)
  })

  it('throws when required fields are missing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ device_code: '' }))
    await expect(startDeviceFlow(fetchSpy as any)).rejects.toThrow(/missing required/)
  })

  it('falls back to defaults when expires_in / interval are absent', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({
      device_code: 'DC-2',
      user_code: 'AAAA',
      verification_uri: 'https://github.com/login/device',
    }))
    const data = await startDeviceFlow(fetchSpy as any)
    expect(data.expires_in).toBe(900)
    expect(data.interval).toBe(5)
  })
})

describe('pollDeviceFlow', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns success when access_token is present', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({
      access_token: 'gho_abc',
      token_type: 'bearer',
      scope: 'read:user',
    }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('success')
    if (r.kind === 'success') {
      expect(r.access_token).toBe('gho_abc')
      expect(r.token_type).toBe('bearer')
    }
  })

  it('maps authorization_pending → pending', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ error: 'authorization_pending' }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('pending')
  })

  it('maps slow_down → slow_down', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ error: 'slow_down' }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('slow_down')
  })

  it('maps access_denied → denied', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ error: 'access_denied' }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('denied')
  })

  it('maps expired_token → expired', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ error: 'expired_token' }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('expired')
  })

  it('maps unknown server errors → error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({
      error: 'unsupported_grant_type',
      error_description: 'bad grant',
    }))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.error).toBe('unsupported_grant_type')
      expect(r.description).toBe('bad grant')
    }
  })

  it('returns error on network failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await pollDeviceFlow('DC-1', fetchSpy as any)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.error).toBe('network')
  })

  it('POSTs grant_type, client_id, device_code', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse({ access_token: 'gho_x' }))
    await pollDeviceFlow('DEVICE-CODE-XYZ', fetchSpy as any)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://github.com/login/oauth/access_token')
    const body = String(init.body)
    expect(body).toContain(`client_id=${encodeURIComponent(COPILOT_OAUTH_CLIENT_ID)}`)
    expect(body).toContain('device_code=DEVICE-CODE-XYZ')
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')
  })
})
