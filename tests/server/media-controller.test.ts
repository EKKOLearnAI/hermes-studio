import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWebuiStateDir = process.env.HERMES_WEBUI_STATE_DIR

afterEach(() => {
  vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
  vi.doUnmock('../../packages/server/src/services/config-helpers')
  vi.doUnmock('../../packages/server/src/services/ekko-agent/provider-runtime')
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

  it.each([
    { provider: 'minimax', endpoint: 'https://api.minimax.io/v1/image_generation' },
    { provider: 'minimax-cn', endpoint: 'https://api.minimaxi.com/v1/image_generation' },
  ])('generates MiniMax images through the $provider regional endpoint', async ({ provider, endpoint }) => {
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    const resolveProviderRuntime = vi.fn(async () => ({
      provider,
      apiKey: 'minimax-test-key',
      baseUrl: 'https://unused.minimax.example/v1',
    }))
    vi.doMock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({
      resolveEkkoProviderRuntimeConfig: resolveProviderRuntime,
    }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { image_urls: ['aW1hZ2UtYnl0ZXM='] },
      metadata: { success_count: 1, failed_count: 0 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider,
            mode: 'text',
            model: 'image-01-live',
            prompt: 'make a cinematic portrait',
            aspect_ratio: '3:4',
            width: 864,
            height: 1152,
            response_format: 'base64',
            seed: 42,
            n: 1,
            prompt_optimizer: true,
            output_path: `/tmp/hermes-web-ui-${provider}-image.png`,
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
        provider,
        base_url: endpoint,
        metadata: { success_count: 1, failed_count: 0 },
      })
      expect(resolveProviderRuntime).toHaveBeenCalledWith({
        profile: 'default',
        provider,
      })
      expect(fetchMock).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Accept: 'application/json',
            Authorization: 'Bearer minimax-test-key',
            'Content-Type': 'application/json',
          }),
        }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toEqual({
        model: 'image-01-live',
        prompt: 'make a cinematic portrait',
        response_format: 'base64',
        n: 1,
        aspect_ratio: '3:4',
        width: 864,
        height: 1152,
        seed: 42,
        prompt_optimizer: true,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('converts MiniMax image input into a subject reference', async () => {
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({
      resolveEkkoProviderRuntimeConfig: vi.fn(async () => ({
        provider: 'minimax',
        apiKey: 'minimax-test-key',
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { image_urls: ['aW1hZ2UtYnl0ZXM='] },
      metadata: { success_count: '1', failed_count: '0' },
      base_resp: { status_code: 0 },
    }), { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'minimax',
            mode: 'image',
            model: 'image-01',
            prompt: 'preserve the reference subject',
            image_base64: 'aW1hZ2UtYnl0ZXM=',
            mime_type: 'image/png',
            response_format: 'base64',
            output_path: '/tmp/hermes-web-ui-minimax-reference.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'image-01',
        subject_reference: [{
          type: 'character',
          image_file: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
        }],
      })
      expect(ctx.body.metadata).toEqual({ success_count: 1, failed_count: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('downloads MiniMax URL results before saving them', async () => {
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({
      resolveEkkoProviderRuntimeConfig: vi.fn(async () => ({
        provider: 'minimax',
        apiKey: 'minimax-test-key',
      })),
    }))
    const resultUrl = 'https://cdn.minimax.example/generated.png'
    const fetchMock = vi.fn(async (url: string) => {
      if (url === resultUrl) {
        return new Response('downloaded-image', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      }
      return new Response(JSON.stringify({
        data: { image_urls: [resultUrl] },
        metadata: { success_count: 1, failed_count: 0 },
        base_resp: { status_code: 0 },
      }), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'minimax',
            mode: 'text',
            prompt: 'make an image',
            response_format: 'url',
            output_path: '/tmp/hermes-web-ui-minimax-url.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.minimax.io/v1/image_generation', expect.any(Object))
      expect(fetchMock).toHaveBeenNthCalledWith(2, resultUrl)
      expect(ctx.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
