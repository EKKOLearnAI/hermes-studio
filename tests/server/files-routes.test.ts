import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = {
  listDir: vi.fn(),
  stat: vi.fn(),
  deleteFile: vi.fn(),
  deleteDir: vi.fn(),
  writeFile: vi.fn(),
}
const createFileProviderMock = vi.fn(async () => provider)
const resolveHermesPathMock = vi.fn((relativePath: string) => {
  const normalized = relativePath.replace(/^\/+/, '')
  return normalized ? `/home/agent/.hermes/${normalized}` : '/home/agent/.hermes'
})

vi.mock('../../packages/server/src/services/hermes/file-provider', () => ({
  createFileProvider: createFileProviderMock,
  resolveHermesPath: resolveHermesPathMock,
  isSensitivePath: vi.fn(() => false),
  MAX_EDIT_SIZE: 10 * 1024 * 1024,
}))

describe('file routes path metadata', () => {
  beforeEach(() => {
    vi.resetModules()
    createFileProviderMock.mockClear()
    resolveHermesPathMock.mockClear()
    provider.listDir.mockReset()
    provider.stat.mockReset()
    provider.deleteFile.mockReset()
    provider.deleteDir.mockReset()
    provider.writeFile.mockReset()
  })

  it('returns absolute paths for listed entries while preserving relative operation paths', async () => {
    provider.listDir.mockResolvedValue([
      { name: 'app.log', path: 'logs/app.log', isDir: false, size: 12, modTime: '2026-05-20T00:00:00.000Z' },
    ])

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/list')
    const ctx: any = { query: { path: 'logs' }, state: { profile: { name: 'research' } }, body: null }

    await layer.stack[0](ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('logs', 'research')
    expect(provider.listDir).toHaveBeenCalledWith('/home/agent/.hermes/logs')
    expect(ctx.body).toEqual({
      path: 'logs',
      absolutePath: '/home/agent/.hermes/logs',
      entries: [
        {
          name: 'app.log',
          path: 'logs/app.log',
          absolutePath: '/home/agent/.hermes/logs/app.log',
          isDir: false,
          size: 12,
          modTime: '2026-05-20T00:00:00.000Z',
        },
      ],
    })
  })

  it('returns an absolute path in stat responses', async () => {
    provider.stat.mockResolvedValue({
      name: 'app.log',
      path: 'logs/app.log',
      isDir: false,
      size: 12,
      modTime: '2026-05-20T00:00:00.000Z',
    })

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/stat')
    const ctx: any = { query: { path: 'logs/app.log' }, state: { profile: { name: 'research' } }, body: null }

    await layer.stack[0](ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('logs/app.log', 'research')
    expect(ctx.body).toEqual({
      name: 'app.log',
      path: 'logs/app.log',
      absolutePath: '/home/agent/.hermes/logs/app.log',
      isDir: false,
      size: 12,
      modTime: '2026-05-20T00:00:00.000Z',
    })
  })

  it('deletes files from the parsed request body', async () => {
    provider.deleteFile.mockResolvedValue(undefined)

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/delete')
    const ctx: any = {
      request: { body: { path: 'workspace/weather.txt', recursive: false } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await layer.stack[0](ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/weather.txt', 'research')
    expect(provider.deleteFile).toHaveBeenCalledWith('/home/agent/.hermes/workspace/weather.txt')
    expect(provider.deleteDir).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('returns missing_path instead of throwing when delete body is absent', async () => {
    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/delete')
    const ctx: any = {
      request: { body: undefined },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await layer.stack[0](ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing path parameter', code: 'missing_path' })
    expect(createFileProviderMock).not.toHaveBeenCalled()
    expect(provider.deleteFile).not.toHaveBeenCalled()
    expect(provider.deleteDir).not.toHaveBeenCalled()
  })

  it('uploads files with boundary parameters and RFC 5987 filenames', async () => {
    provider.writeFile.mockResolvedValue(undefined)
    const boundary = 'files-boundary'
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'daily%20report.txt',
      'Content-Type: text/plain',
      '',
      'hello',
      `--${boundary}--`,
      '',
    ].join('\r\n'))

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/upload')
    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: { profile: { name: 'research' } },
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}; charset=utf-8`
        : ''),
    }

    await layer.stack[0](ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/daily report.txt', 'research')
    expect(provider.writeFile).toHaveBeenCalledWith(
      '/home/agent/.hermes/workspace/daily report.txt',
      Buffer.from('hello'),
    )
    expect(ctx.body).toEqual({
      files: [{ name: 'daily report.txt', path: 'workspace/daily report.txt' }],
    })
  })

  it('returns invalid_request for malformed RFC 5987 filenames', async () => {
    const boundary = 'files-boundary'
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'bad%ZZname.txt',
      'Content-Type: text/plain',
      '',
      'hello',
      `--${boundary}--`,
      '',
    ].join('\r\n'))

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/upload')
    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: { profile: { name: 'research' } },
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}`
        : ''),
    }

    await layer.stack[0](ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename', code: 'invalid_request' })
    expect(provider.writeFile).not.toHaveBeenCalled()
  })
})
