import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  ensureDesktopAuthReady: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => 'theme-token'),
  getBaseUrlValue: vi.fn(() => ''),
  request: vi.fn(),
}))

import {
  clearThemeBackgroundCache,
  fetchThemeBackgroundBlob,
} from '@/api/theme'

describe('theme background cache', () => {
  const entries = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => {
      entries.set(key, response.clone())
    }),
    keys: vi.fn(async () => [...entries.keys()].map(key => new Request(key))),
    delete: vi.fn(async (request: Request) => entries.delete(request.url)),
  }

  beforeEach(() => {
    entries.clear()
    vi.clearAllMocks()
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cache),
    })
  })

  it('stores image blobs in Cache Storage and reuses them without localStorage writes', async () => {
    const image = new Blob(['background-image'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const localStorageWrite = vi.fn()
    vi.stubGlobal('localStorage', { setItem: localStorageWrite })

    const first = await fetchThemeBackgroundBlob(7, 100)
    const second = await fetchThemeBackgroundBlob(7, 100)

    expect(await first.text()).toBe('background-image')
    expect(await second.text()).toBe('background-image')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
    expect(localStorageWrite).not.toHaveBeenCalled()

    await clearThemeBackgroundCache(7)
    expect(entries.size).toBe(0)
  })
})
