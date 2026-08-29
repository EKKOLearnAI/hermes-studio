import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchStudioVersionManifest,
  STUDIO_VERSION_MANIFEST_URL,
} from '../../packages/client/src/api/studio/versions'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Studio version manifest client', () => {
  it('loads the production Studio manifest', async () => {
    const manifest = {
      schema: 1 as const,
      hermes: ['0.20.4'],
      mobile: {
        version: '1.0.0',
        channels: {
          androidApk: { githubUrl: 'https://github.example/app.apk', cloudflareUrl: 'https://cf.example/app.apk', online: true },
          googlePlay: { url: 'https://play.google.com/app', online: true },
          apple: { testFlightUrl: 'https://testflight.apple.com/join/test', appStoreUrl: 'https://apps.apple.com/app/test', online: true },
          harmony: { url: 'https://appgallery.huawei.com/app/test', online: true },
        },
      },
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchStudioVersionManifest()).resolves.toEqual(manifest)
    expect(STUDIO_VERSION_MANIFEST_URL).toBe('https://api.hermes-studio.ai/api/studio/versions')
    expect(fetchMock).toHaveBeenCalledWith(STUDIO_VERSION_MANIFEST_URL, {
      headers: { Accept: 'application/json' },
    })
  })

  it('rejects an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ schema: 1 }) }))

    await expect(fetchStudioVersionManifest()).rejects.toThrow('Invalid Studio version manifest')
  })
})
