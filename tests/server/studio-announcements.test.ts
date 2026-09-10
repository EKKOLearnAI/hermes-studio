import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStudioAnnouncements } from '../../packages/server/src/modules/studio/services/notifications/announcements'
import { getAnnouncements } from '../../packages/server/src/modules/studio/controllers/announcements'

afterEach(() => vi.unstubAllGlobals())

describe('Studio announcement delivery', () => {
  it.each([['zh-TW', 'zh-CN'], ['zh', 'zh-CN'], ['en', 'en'], ['ja', 'en']])('fetches desktop announcements for %s', async (input, expectedLocale) => {
    const data = { ok: true, platform: 'desktop', list: [{ id: 2 }, { id: 1 }] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchStudioAnnouncements(input)).toEqual(data)
    expect(fetchMock).toHaveBeenCalledWith(`https://api.ekkostudio.xyz/api/studio/announcements?locale=${expectedLocale}`, {
      headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal),
    })
  })

  it.each([
    { ok: true, platform: 'app', list: [] },
    { ok: false, platform: 'desktop', list: [] },
    { ok: true, platform: 'desktop', list: null },
    null,
  ])('rejects a malformed or wrong-platform response', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(fetchStudioAnnouncements('en')).rejects.toThrow()
  })

  it('returns a non-auth error for an unavailable announcement service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    const ctx = { query: { locale: 'en' }, set: vi.fn() } as any
    await getAnnouncements(ctx)
    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ ok: false, error: 'announcement_fetch_failed' })
    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
