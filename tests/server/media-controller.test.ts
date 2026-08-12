import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWebuiStateDir = process.env.HERMES_WEBUI_STATE_DIR

afterEach(() => {
  vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
  vi.doUnmock('../../packages/server/src/services/config-helpers')
  vi.doUnmock('../../packages/server/src/services/hermes/authorized-provider-credentials')
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  if (originalWebuiStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
  else process.env.HERMES_WEBUI_STATE_DIR = originalWebuiStateDir
})

describe('media controller', () => {
  it('uses Hermes Web UI media directory as the default generated video output path', async () => {
    process.env.HERMES_WEB_UI_HOME = '/tmp/hermes-web-ui-test-home'
    const { defaultImageOutputPath, defaultMediaOutputPath } = await import('../../packages/server/src/controllers/hermes/media')

    expect(defaultMediaOutputPath('req_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'req_123.mp4'))
    expect(defaultMediaOutputPath('bad/request:id')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id.mp4'))
    expect(defaultImageOutputPath('img_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'img_123.png'))
    expect(defaultImageOutputPath('bad/request:id', 1)).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id-2.png'))
  })

  it('generates images through the requested configured custom provider', async () => {
    vi.stubEnv('AGNES_API_KEY', 'agnes-secret')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'agnes',
          base_url: 'https://agnes.example/v1',
          api_key_env: 'AGNES_API_KEY',
          model: 'agnes-image-2.1-flash',
        }],
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"data":[{"b64_json":"aW1hZ2UtYnl0ZXM="}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'agnes',
            mode: 'text',
            prompt: 'make an icon',
            output_path: '/tmp/hermes-web-ui-agnes-image.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        ok: true,
        mode: 'text',
        provider: 'agnes',
        base_url: 'https://agnes.example/v1',
        profile: 'default',
      })
      expect(fetchMock).toHaveBeenCalledWith(
        'https://agnes.example/v1/images/generations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer agnes-secret',
            'Content-Type': 'application/json',
          }),
        }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'make an icon',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forces response storage off for reference-image generation', async () => {
    vi.stubEnv('AGNES_API_KEY', 'agnes-secret')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'agnes',
          base_url: 'https://agnes.example/v1',
          api_key_env: 'AGNES_API_KEY',
          model: 'agnes-image-2.1-flash',
        }],
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"output":[{"result":"aW1hZ2UtYnl0ZXM="}]} }\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'agnes',
            mode: 'image',
            prompt: 'redraw this icon',
            image_base64: 'aW1hZ2UtYnl0ZXM=',
            mime_type: 'image/png',
            store: true,
            output_path: '/tmp/hermes-web-ui-agnes-reference-image.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://agnes.example/v1/responses',
        expect.objectContaining({ method: 'POST' }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'agnes-image-2.1-flash',
        store: false,
        stream: true,
        tools: [{
          type: 'image_generation',
          model: 'gpt-image-2',
        }],
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects MiniMax image-to-video without credentials', async () => {
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({})),
    }))
    vi.doMock('../../packages/server/src/services/hermes/authorized-provider-credentials', () => ({
      resolveAuthorizedProviderRuntimeCredentials: vi.fn(async () => {
        throw new Error('MiniMax authorization is unavailable')
      }),
    }))
    const { miniMaxImageToVideo } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx: any = {
      state: { serverTokenAuth: true },
      query: {},
      request: { body: { prompt: 'animate the scene', image_url: 'https://cdn.example.com/source.png' } },
      get: vi.fn(() => ''),
      status: 200,
      body: undefined,
    }

    await miniMaxImageToVideo(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toMatchObject({ code: 'missing_minimax_token' })
  })

  it('generates MiniMax-H3 image-to-video through the global v2 endpoint', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-test-key')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({})),
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v2/query/video_generation/task_h3')) {
        return new Response(JSON.stringify({
          task: {
            id: 'task_h3',
            model: 'MiniMax-H3',
            status: 'succeeded',
            content: { url: 'https://cdn.example.com/video-h3.mp4' },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlString.includes('/v2/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_h3' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            prompt: 'animate the water and clouds',
            image_url: 'https://cdn.example.com/source.png',
            output_path: '/tmp/hermes-web-ui-minimax-image-video.mp4',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        task_id: 'task_h3',
        status: 'succeeded',
        model: 'MiniMax-H3',
        api_version: 'v2',
        region: 'global_en',
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v2/video_generation')
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        model: 'MiniMax-H3',
        content: [
          { type: 'text', text: 'animate the water and clouds' },
          {
            type: 'image_url',
            image_url: { url: 'https://cdn.example.com/source.png' },
            role: 'first_frame',
          },
        ],
        resolution: '2K',
        duration: 5,
        ratio: 'adaptive',
      })
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.minimax.io/v2/query/video_generation/task_h3')
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })

  it('uses refreshed MiniMax authorization credentials and the CN v2 endpoint', async () => {
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({})),
    }))
    const resolveAuthorizedProviderRuntimeCredentials = vi.fn(async () => ({
      provider: 'minimax-oauth',
      apiKey: 'fresh-minimax-token',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      source: 'oauth-refresh',
    }))
    vi.doMock('../../packages/server/src/services/hermes/authorized-provider-credentials', () => ({
      resolveAuthorizedProviderRuntimeCredentials,
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v2/query/video_generation/task_cn')) {
        return new Response(JSON.stringify({
          task: {
            id: 'task_cn',
            model: 'MiniMax-H3',
            status: 'succeeded',
            content: { url: 'https://cdn.example.com/video-cn.mp4' },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlString.includes('/v2/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_cn' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            prompt: 'animate the portrait',
            image_url: 'https://cdn.example.com/portrait.png',
            aigc_watermark: true,
            output_path: '/tmp/hermes-web-ui-minimax-image-video-cn.mp4',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        task_id: 'task_cn',
        model: 'MiniMax-H3',
        api_version: 'v2',
        region: 'cn_zh',
        token_source: 'oauth-refresh',
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimaxi.com/v2/video_generation')
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-minimax-token' }),
      })
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
        aigc_watermark: true,
      })
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })

  it('uses the MiniMax v1 image-to-video workflow for an explicit v1 model', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-test-key')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({})),
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v1/query/video_generation')) {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file_v1', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/files/retrieve')) {
        return new Response(JSON.stringify({ file: { download_url: 'https://cdn.example.com/video-v1.mp4' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_v1', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            model: 'MiniMax-Hailuo-2.3',
            prompt: 'animate the portrait',
            image_url: 'https://cdn.example.com/portrait.png',
            duration: 6,
            resolution: '1080P',
            output_path: '/tmp/hermes-web-ui-minimax-image-video-v1.mp4',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        task_id: 'task_v1',
        file_id: 'file_v1',
        model: 'MiniMax-Hailuo-2.3',
        api_version: 'v1',
        region: 'global_en',
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/video_generation')
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
        model: 'MiniMax-Hailuo-2.3',
        first_frame_image: 'https://cdn.example.com/portrait.png',
        prompt: 'animate the portrait',
        duration: 6,
        resolution: '1080P',
      })
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })
})
