// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// vi.mock is hoisted, so mockReplace must be inside the factory
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import { getApiKey, setApiKey, clearApiKey, hasApiKey, getStoredUserRole, isStoredSuperAdmin, request } from '../../packages/client/src/api/client'
import { getDownloadUrl } from '../../packages/client/src/api/hermes/download'
import { uploadFiles } from '../../packages/client/src/api/hermes/files'
import router from '@/router'

function fakeJwt(payload: Record<string, unknown>) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${header}.${body}.signature`
}

describe('API Client', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  describe('token management', () => {
    it('hasApiKey returns false when no token', () => {
      expect(hasApiKey()).toBe(false)
    })

    it('hasApiKey returns true after setApiKey', () => {
      setApiKey('test-token')
      expect(hasApiKey()).toBe(true)
    })

    it('getApiKey returns the stored token', () => {
      setApiKey('my-token')
      expect(getApiKey()).toBe('my-token')
    })

    it('clearApiKey removes the token', () => {
      setApiKey('my-token')
      clearApiKey()
      expect(hasApiKey()).toBe(false)
      expect(getApiKey()).toBe('')
    })

    it('reads the role from the stored JWT payload', () => {
      setApiKey(fakeJwt({ sub: '1', role: 'super_admin' }))

      expect(getStoredUserRole()).toBe('super_admin')
      expect(isStoredSuperAdmin()).toBe(true)

      setApiKey(fakeJwt({ sub: '2', role: 'admin' }))
      expect(getStoredUserRole()).toBe('admin')
      expect(isStoredSuperAdmin()).toBe(false)
    })
  })

  describe('request', () => {
    it('adds Authorization header when token exists', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBe('Bearer secret-key')
    })

    it('adds the active profile header, including default', async () => {
      localStorage.setItem('hermes_active_profile_name', 'default')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBe('default')
    })

    it('does not add Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBeUndefined()
    })

    it('clears token and redirects on 401 for local BFF endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401 })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('Unauthorized')
      expect(hasApiKey()).toBe(false)
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('emits a global auth notice on local 403 responses', async () => {
      const listener = vi.fn()
      window.addEventListener('hermes-auth-notice', listener)
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].detail).toEqual({ kind: 'forbidden' })
      window.removeEventListener('hermes-auth-notice', listener)
    })

    it('clears token and redirects when the JWT user no longer exists', async () => {
      setApiKey('stale-jwt')
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"User is disabled or does not exist"}'),
      })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(hasApiKey()).toBe(false)
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('does NOT clear token on 401 for proxied v1 endpoints', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/v1/runs')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
    })

    it('throws error on non-401 failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('API Error 500: Internal Server Error')
    })

    it('returns parsed JSON on success', async () => {
      const data = { sessions: [{ id: '1' }] }
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(data) })

      const result = await request('/api/hermes/sessions')
      expect(result).toEqual(data)
    })
  })

  describe('download URLs', () => {
    it('adds the active profile selector to direct download URLs', () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')

      const url = new URL(getDownloadUrl('/tmp/report.txt', 'report.txt'), 'http://localhost')

      expect(url.pathname).toBe('/api/hermes/download')
      expect(url.searchParams.get('path')).toBe('/tmp/report.txt')
      expect(url.searchParams.get('name')).toBe('report.txt')
      expect(url.searchParams.get('profile')).toBe('research')
      expect(url.searchParams.get('token')).toBe('secret-key')
    })
  })

  describe('file upload', () => {
    it('adds auth and active profile headers to multipart uploads', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      })

      await uploadFiles('notes', [new File(['hello'], 'hello.txt', { type: 'text/plain' })])

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/files/upload?path=notes')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBe('research')
      expect(options.body).toBeInstanceOf(FormData)
    })
  })
})
