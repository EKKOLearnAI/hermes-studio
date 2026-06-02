// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import {
  fetchMyAvatar,
  resetMyAvatar,
  updateMyAvatar,
} from '../../packages/client/src/api/auth'
import { setApiKey } from '../../packages/client/src/api/client'

function makeResponse(status: number, body: any, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

describe('client auth API: avatar endpoints', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    setApiKey('test-token')
  })

  describe('fetchMyAvatar', () => {
    it('returns null when the server responds with an empty avatar string', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { avatar: '' }))

      const avatar = await fetchMyAvatar()

      expect(avatar).toBeNull()
      expect(mockFetch).toHaveBeenCalledOnce()
      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/auth/avatar')
    })

    it('returns null when the server returns an unparseable JSON string', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { avatar: '{not valid json' }))

      const avatar = await fetchMyAvatar()

      expect(avatar).toBeNull()
    })

    it('returns null when the parsed avatar has an unknown type', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse(200, { avatar: JSON.stringify({ type: 'emoji', seed: 'x' }) }),
      )

      const avatar = await fetchMyAvatar()

      expect(avatar).toBeNull()
    })

    it('parses a valid image avatar payload from the server', async () => {
      const payload = { type: 'image' as const, dataUrl: 'data:image/png;base64,AAAA' }
      mockFetch.mockResolvedValueOnce(makeResponse(200, { avatar: JSON.stringify(payload) }))

      const avatar = await fetchMyAvatar()

      expect(avatar).toEqual(payload)
    })

    it('parses a valid default avatar payload from the server', async () => {
      const payload = { type: 'default' as const, seed: 'abc' }
      mockFetch.mockResolvedValueOnce(makeResponse(200, { avatar: JSON.stringify(payload) }))

      const avatar = await fetchMyAvatar()

      expect(avatar).toEqual(payload)
    })
  })

  describe('updateMyAvatar', () => {
    it('PUTs the avatar as a JSON-string field to /api/auth/avatar', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { success: true, avatar: '' }))
      const payload = { type: 'image' as const, dataUrl: 'data:image/png;base64,HI==' }

      await updateMyAvatar(payload)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/auth/avatar')
      expect(options.method).toBe('PUT')
      expect(options.headers['Content-Type']).toBe('application/json')

      const body = JSON.parse(options.body)
      expect(body.avatar).toBe(JSON.stringify(payload))
      // The string must round-trip parse to the same object
      expect(JSON.parse(body.avatar)).toEqual(payload)
    })
  })

  describe('resetMyAvatar', () => {
    it('PUTs a default avatar object to /api/auth/avatar', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { success: true }))

      await resetMyAvatar()

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/auth/avatar')
      expect(options.method).toBe('PUT')
      const body = JSON.parse(options.body)
      expect(body).toEqual({ avatar: { type: 'default' } })
    })
  })
})
