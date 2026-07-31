import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWebuiStateDir = process.env.HERMES_WEBUI_STATE_DIR
const originalWorkspaceBase = process.env.WORKSPACE_BASE
const originalFetch = globalThis.fetch

function pngBase64(width = 1, height = 1): string {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer.toString('base64')
}

function mockImageProvider() {
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
}

function imageResponse(base64 = pngBase64()): Response {
  return new Response(
    `data: {"data":[{"b64_json":"${base64}"}]}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function mediaContext(body: Record<string, unknown>, requestId = ''): any {
  return {
    state: { serverTokenAuth: true },
    query: {},
    request: { body },
    get: vi.fn((name: string) => name.toLowerCase() === 'x-request-id' ? requestId : ''),
    status: 200,
    body: undefined,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
  vi.doUnmock('../../packages/server/src/services/config-helpers')
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  if (originalWebuiStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
  else process.env.HERMES_WEBUI_STATE_DIR = originalWebuiStateDir
  if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
  else process.env.WORKSPACE_BASE = originalWorkspaceBase
})

describe('media controller', () => {
  it('uses Hermes Web UI media directory as the default generated video output path', async () => {
    process.env.HERMES_WEB_UI_HOME = '/tmp/hermes-web-ui-test-home'
    const { defaultImageOutputPath, defaultMediaOutputPath } = await import('../../packages/server/src/controllers/hermes/media')

    expect(defaultMediaOutputPath('req_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'req_123.mp4'))
    expect(defaultMediaOutputPath('bad/request:id')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id.mp4'))
    expect(defaultImageOutputPath('img_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'img_123.png'))
    expect(defaultImageOutputPath('bad/request:id', 1)).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id-2.png'))
    expect(defaultImageOutputPath('img_123', 0, 'jpeg')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'img_123.jpg'))
  })

  it('resolves a key_env credential from the requested profile .env', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'hermes-media-xiaoyan-profile-'))
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-axon-output-'))
    const envName = 'AXONHUB_XIAOYAN_API_KEY'
    const previousProcessValue = process.env[envName]
    delete process.env[envName]
    await writeFile(join(profileDir, '.env'), [
      '',
      '# profile-scoped custom provider credential',
      `export ${envName}='axon-profile-secret' # ignored comment`,
      '',
    ].join('\n'))
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: (profile: string) => profile === 'xiaoyan' ? profileDir : '/tmp/hermes-default-profile',
      listProfileNamesFromDisk: () => ['default', 'xiaoyan'],
    }))
    const readConfigYamlForProfile = vi.fn(async () => ({
      custom_providers: [{
        name: 'axon',
        base_url: 'https://axon.example/v1',
        key_env: envName,
        model: 'axon-image-1',
      }],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({ readConfigYamlForProfile }))
    const fetchMock = vi.fn(async () => imageResponse())
    globalThis.fetch = fetchMock as any

    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        profile: 'xiaoyan',
        provider: 'axon',
        mode: 'text',
        prompt: 'use the profile provider',
        output_path: join(outputDir, 'result.png'),
      })

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        ok: true,
        provider: 'axon',
        actual_provider: 'axon',
        profile: 'xiaoyan',
      })
      expect(JSON.stringify(ctx.body)).not.toContain('axon-profile-secret')
      expect(readConfigYamlForProfile).toHaveBeenCalledWith('xiaoyan')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://axon.example/v1/images/generations',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer axon-profile-secret' }),
        }),
      )
    } finally {
      if (previousProcessValue === undefined) delete process.env[envName]
      else process.env[envName] = previousProcessValue
      await rm(profileDir, { recursive: true, force: true })
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('returns the public missing-provider error when key_env is absent from process and profile .env', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'hermes-media-xiaoyan-missing-key-'))
    const envName = 'AXONHUB_XIAOYAN_API_KEY'
    const previousProcessValue = process.env[envName]
    delete process.env[envName]
    await writeFile(join(profileDir, '.env'), '# no axon credential\nOTHER_KEY=other-value\n')
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: (profile: string) => profile === 'xiaoyan' ? profileDir : '/tmp/hermes-default-profile',
      listProfileNamesFromDisk: () => ['default', 'xiaoyan'],
    }))
    vi.doMock('../../packages/server/src/services/config-helpers', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'axon',
          base_url: 'https://axon.example/v1',
          key_env: envName,
          model: 'axon-image-1',
        }],
      })),
    }))
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any

    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        profile: 'xiaoyan',
        provider: 'axon',
        mode: 'text',
        prompt: 'missing credential',
      })

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toMatchObject({
        error: 'The requested image provider is not configured',
        code: 'missing_apikey_image_provider',
      })
      expect(JSON.stringify(ctx.body)).not.toContain(envName)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      if (previousProcessValue === undefined) delete process.env[envName]
      else process.env[envName] = previousProcessValue
      await rm(profileDir, { recursive: true, force: true })
    }
  })

  it('passes native 4K generation options and returns actual provider, model, dimensions, format, and request id', async () => {
    mockImageProvider()
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-4k-'))
    const fetchMock = vi.fn(async () => imageResponse(pngBase64(3840, 2160)))
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        provider: 'agnes',
        mode: 'text',
        prompt: 'make a 4K icon',
        model: 'codex-gpt-image-2',
        quality: 'high',
        resolution: '4k',
        aspect: '16:9',
        output_path: join(outputDir, 'result.png'),
      }, 'req-4k-123')

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        ok: true,
        mode: 'text',
        provider: 'agnes',
        base_url: 'https://agnes.example/v1',
        profile: 'default',
        request_id: 'req-4k-123',
        model: 'codex-gpt-image-2',
        actual_model: 'codex-gpt-image-2',
        actual_provider: 'agnes',
        quality: 'high',
        resolution: '4k',
        aspect: '16:9',
        dimensions: { width: 3840, height: 2160 },
        format: 'png',
      })
      expect(ctx.body.output_paths).toEqual([join(outputDir, 'result.png')])
      expect(ctx.body.images).toEqual([{
        output_path: join(outputDir, 'result.png'),
        dimensions: { width: 3840, height: 2160 },
        format: 'png',
      }])
      expect(fetchMock).toHaveBeenCalledWith(
        'https://agnes.example/v1/images/generations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer agnes-secret',
            'Content-Type': 'application/json',
            'X-Request-Id': 'req-4k-123',
          }),
        }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'codex-gpt-image-2',
        prompt: 'make a 4K icon',
        quality: 'high',
        resolution: '4k',
        aspect_ratio: '16:9',
      })
      expect(String(requestInit.body)).not.toContain('resize')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('keeps image_path, image_url, and image_base64 as compatible single-reference inputs', async () => {
    mockImageProvider()
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-legacy-'))
    const sourcePath = join(outputDir, 'reference.png')
    await writeFile(sourcePath, Buffer.from(pngBase64(), 'base64'))
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input) === 'https://93.184.216.34/reference.png') {
        return new Response(Buffer.from(pngBase64(), 'base64'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      }
      return imageResponse()
    })
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const sources = [
        { image_path: sourcePath },
        { image_url: 'https://93.184.216.34/reference.png' },
        { image_base64: pngBase64(), mime_type: 'image/png' },
      ]
      for (const [index, source] of sources.entries()) {
        const ctx = mediaContext({
          provider: 'agnes',
          mode: 'image',
          prompt: 'use the reference',
          ...source,
          output_path: join(outputDir, `result-${index}.png`),
        })
        await apiKeyImageGenerate(ctx)
        expect(ctx.status).toBe(200)
      }

      const upstreamCalls = fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/responses'))
      expect(upstreamCalls).toHaveLength(3)
      for (const call of upstreamCalls) {
        const payload = JSON.parse(String((call[1] as RequestInit).body))
        expect(payload.input[0].content[1]).toMatchObject({
          type: 'input_image',
          reference_role: 'reference',
          priority: 0,
        })
        expect(payload.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/)
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('passes multiple reference roles, priorities, and weights to the provider', async () => {
    mockImageProvider()
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-references-'))
    const fetchMock = vi.fn(async () => imageResponse())
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        provider: 'agnes',
        mode: 'image',
        prompt: 'combine both references',
        model: 'codex-gpt-image-2',
        response_model: 'gpt-5.4-mini',
        references: [
          { image_base64: pngBase64(), mime_type: 'image/png', role: 'composition', priority: 1 },
          { image_base64: pngBase64(), mime_type: 'image/png', role: 'style', weight: 0.75 },
        ],
        output_path: join(outputDir, 'result.png'),
      })

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      const payload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(payload.model).toBe('gpt-5.4-mini')
      expect(payload.input[0].content.slice(1)).toEqual([
        expect.objectContaining({ type: 'input_image', reference_role: 'composition', priority: 1 }),
        expect.objectContaining({ type: 'input_image', reference_role: 'style', weight: 0.75 }),
      ])
      expect(payload.tools[0]).toMatchObject({
        model: 'codex-gpt-image-2',
        quality: 'high',
        resolution: '4k',
        aspect_ratio: 'auto',
      })

      const editCtx = mediaContext({
        provider: 'agnes',
        mode: 'edit',
        prompt: 'edit with both responsibilities',
        references: [
          { image_base64: pngBase64(), mime_type: 'image/png', role: 'subject', priority: 2 },
          { image_base64: pngBase64(), mime_type: 'image/png', role: 'palette', weight: 0.5 },
        ],
        output_path: join(outputDir, 'edited.png'),
      })
      await apiKeyImageGenerate(editCtx)
      expect(editCtx.status).toBe(200)
      const editForm = fetchMock.mock.calls[1][1]?.body as FormData
      expect(editForm.getAll('image[]')).toHaveLength(2)
      expect(editForm.get('reference_role[0]')).toBe('subject')
      expect(editForm.get('reference_priority[0]')).toBe('2')
      expect(editForm.get('reference_role[1]')).toBe('palette')
      expect(editForm.get('reference_weight[1]')).toBe('0.5')
      expect(editForm.get('resolution')).toBe('4k')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid reference count, metadata, MIME, and unsafe local paths with actionable codes', async () => {
    mockImageProvider()
    globalThis.fetch = vi.fn() as any
    const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const cases = [
      {
        references: Array.from({ length: 9 }, () => ({
          image_base64: pngBase64(),
          mime_type: 'image/png',
          role: 'style',
          priority: 1,
        })),
        code: 'too_many_references',
      },
      {
        references: [{ image_base64: pngBase64(), mime_type: 'image/png', role: 'style' }],
        code: 'reference_metadata_required',
      },
      {
        references: [{ image_base64: pngBase64(), mime_type: 'image/jpeg', role: 'style', priority: 1 }],
        code: 'reference_mime_mismatch',
      },
      {
        image_path: '/etc/passwd',
        code: 'unsafe_reference_path',
      },
    ]

    for (const testCase of cases) {
      const ctx = mediaContext({
        provider: 'agnes',
        mode: 'image',
        prompt: 'test validation',
        ...testCase,
      })
      delete ctx.request.body.code
      await apiKeyImageGenerate(ctx)
      expect(ctx.status).toBeGreaterThanOrEqual(400)
      expect(ctx.body.code).toBe(testCase.code)
      expect(JSON.stringify(ctx.body)).not.toContain('/etc/passwd')
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('redacts upstream credentials, authorization, private paths, and image bodies from errors', async () => {
    mockImageProvider()
    const secretImage = pngBase64()
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: `Authorization: Bearer agnes-secret /private/provider/path ${secretImage}`,
      },
    }), { status: 400 })) as any
    const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = mediaContext({
      provider: 'agnes',
      mode: 'text',
      prompt: 'fail safely',
    })

    await apiKeyImageGenerate(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      error: 'Image provider rejected the generation request',
      code: 'upstream_rejected_request',
    })
    expect(ctx.body.request_id).toMatch(/^[A-Za-z0-9._-]+$/)
    const serialized = JSON.stringify(ctx.body)
    expect(serialized).not.toContain('agnes-secret')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('/private/provider/path')
    expect(serialized).not.toContain(secretImage)
  })

  it('rejects an existing output symlink instead of writing through it', async () => {
    if (process.platform === 'win32') return
    mockImageProvider()
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-output-link-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'hermes-media-output-target-'))
    const outsidePath = join(outsideDir, 'outside.png')
    const linkPath = join(outputDir, 'linked.png')
    await writeFile(outsidePath, Buffer.from('unchanged'))
    await symlink(outsidePath, linkPath)
    globalThis.fetch = vi.fn(async () => imageResponse()) as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        provider: 'agnes',
        mode: 'text',
        prompt: 'do not follow output links',
        output_path: linkPath,
      })

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body.code).toBe('unsafe_output_path')
      expect(await readFile(outsidePath, 'utf8')).toBe('unchanged')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('reports upstream image dimensions without resizing a non-4K result', async () => {
    mockImageProvider()
    const outputDir = await mkdtemp(join(tmpdir(), 'hermes-media-native-'))
    globalThis.fetch = vi.fn(async () => imageResponse(pngBase64(640, 480))) as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
      const ctx = mediaContext({
        provider: 'agnes',
        mode: 'text',
        prompt: 'request 4K',
        resolution: '4k',
        output_path: join(outputDir, 'native.png'),
      })

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.resolution).toBe('4k')
      expect(ctx.body.dimensions).toEqual({ width: 640, height: 480 })
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })
})
