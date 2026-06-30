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
import { importSkill } from '../../packages/client/src/api/hermes/skills'
import { archiveSession, batchDeleteSessions, importHermesSession, unarchiveSession } from '../../packages/client/src/api/hermes/sessions'
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

      await request('/api/hermes/sessions/session-1')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBe('default')
    })

    it('does not add the active profile header to profile-wide session collection requests', async () => {
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    })

    it('does not add Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/hermes/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBeUndefined()
    })

    it('clears token and redirects on 401 for local BFF endpoints', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 401 })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('Unauthorized')
      expect(hasApiKey()).toBe(false)
      expect(localStorage.getItem('hermes_active_profile_name')).toBeNull()
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('emits a global auth notice on local 403 responses', async () => {
      const listener = vi.fn()
      window.addEventListener('hermes-auth-notice', listener)
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].detail).toEqual({ kind: 'forbidden' })
      expect(localStorage.getItem('hermes_active_profile_name')).toBe('research')
      window.removeEventListener('hermes-auth-notice', listener)
    })

    it('clears token and redirects when the JWT user no longer exists', async () => {
      setApiKey('stale-jwt')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"User is disabled or does not exist"}'),
      })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(hasApiKey()).toBe(false)
      expect(localStorage.getItem('hermes_active_profile_name')).toBeNull()
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('does NOT clear token on 401 for proxied v1 endpoints', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/v1/runs')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
      expect(localStorage.getItem('hermes_active_profile_name')).toBe('research')
    })

    it('throws error on non-401 failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      await expect(request('/api/hermes/sessions')).rejects.toThrow('API Error 500: Internal Server Error')
    })

    it('extracts nested JSON error messages instead of stringifying objects', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({
          error: {
            message: 'spawn claude ENOENT',
            code: 'ENOENT',
          },
        })),
      })

      await expect(request('/api/coding-agents/runs/session-1/input')).rejects.toThrow('API Error 500: spawn claude ENOENT')
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

    it('uses an explicit profile selector for direct download URLs', () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')

      const url = new URL(getDownloadUrl('/tmp/reviewer.txt', 'reviewer.txt', 'reviewer'), 'http://localhost')

      expect(url.searchParams.get('path')).toBe('/tmp/reviewer.txt')
      expect(url.searchParams.get('name')).toBe('reviewer.txt')
      expect(url.searchParams.get('profile')).toBe('reviewer')
      expect(url.searchParams.get('token')).toBe('secret-key')
    })

    it('handles raw percent signs in download paths and filenames', () => {
      const url = new URL(getDownloadUrl('/tmp/100% ready.txt', '100% ready.txt'), 'http://localhost')

      expect(url.pathname).toBe('/api/hermes/download')
      expect(url.searchParams.get('path')).toBe('/tmp/100% ready.txt')
      expect(url.searchParams.get('name')).toBe('100% ready.txt')
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

    it('uses an explicit profile selector instead of the active profile header', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      })

      await uploadFiles('notes', [new File(['hello'], 'hello.txt', { type: 'text/plain' })], 'reviewer')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/files/upload?path=notes&profile=reviewer')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    })

    it('adds auth and active profile headers when importing skills', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"name":"demo-skill"}'),
      })

      await importSkill([new File(['# Demo\n'], 'demo.zip', { type: 'application/zip' })])

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/skills/import')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBe('research')
      expect(options.body).toBeInstanceOf(FormData)
    })
  })

  describe('sessions API', () => {
    it('sends profile-qualified targets for batch deletes', async () => {
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ deleted: 2, failed: 0, errors: [] }),
      })

      await batchDeleteSessions([
        { id: 'session-default', profile: 'default' },
        { id: 'session-travel', profile: 'travel' },
      ])

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/sessions/batch-delete')
      expect(options.method).toBe('POST')
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
      expect(JSON.parse(options.body)).toEqual({
        ids: ['session-default', 'session-travel'],
        sessions: [
          { id: 'session-default', profile: 'default' },
          { id: 'session-travel', profile: 'travel' },
        ],
      })
    })

    it('sends the profile selector when importing a Hermes session', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, imported: true }),
      })

      await importHermesSession('cli-1', 'travel')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/sessions/hermes/cli-1/import?profile=travel')
      expect(options.method).toBe('POST')
    })

    it('archives a session through the local session endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      })

      const ok = await archiveSession('session-1')

      const [url, options] = mockFetch.mock.calls[0]
      expect(ok).toBe(true)
      expect(url).toBe('/api/hermes/sessions/session-1/archive')
      expect(options.method).toBe('POST')
    })

    it('unarchives a session through the local session endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      })

      const ok = await unarchiveSession('session-1')

      const [url, options] = mockFetch.mock.calls[0]
      expect(ok).toBe(true)
      expect(url).toBe('/api/hermes/sessions/session-1/unarchive')
      expect(options.method).toBe('POST')
    })
  })
})
