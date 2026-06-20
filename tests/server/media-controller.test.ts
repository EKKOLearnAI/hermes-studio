import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWebuiStateDir = process.env.HERMES_WEBUI_STATE_DIR

afterEach(() => {
  vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
  vi.doUnmock('../../packages/server/src/services/config-helpers')
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
})
