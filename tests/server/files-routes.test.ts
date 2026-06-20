import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = {
  listDir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
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

async function runFileRoute(path: string, ctx: any) {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = fileRoutes.stack.find((entry: any) => entry.path === path)
  if (!layer) throw new Error(`Missing file route ${path}`)

  let index = -1
  async function dispatch(nextIndex: number): Promise<void> {
    if (nextIndex <= index) throw new Error('next() called multiple times')
    index = nextIndex
    const fn = layer.stack[nextIndex]
    if (!fn) return
    await fn(ctx, () => dispatch(nextIndex + 1))
  }

  await dispatch(0)
}

function superAdminState(profile = 'research') {
  return {
    profile: { name: profile },
    user: { id: 1, username: 'owner', role: 'super_admin' },
  }
}

describe('file routes path metadata', () => {
  beforeEach(() => {
    vi.resetModules()
    createFileProviderMock.mockClear()
    resolveHermesPathMock.mockClear()
    provider.listDir.mockReset()
    provider.stat.mockReset()
    provider.readFile.mockReset()
    provider.deleteFile.mockReset()
    provider.deleteDir.mockReset()
    provider.writeFile.mockReset()
  })

  it('returns absolute paths for listed entries while preserving relative operation paths', async () => {
    provider.listDir.mockResolvedValue([
      { name: 'app.log', path: 'logs/app.log', isDir: false, size: 12, modTime: '2026-05-20T00:00:00.000Z' },
    ])

    const ctx: any = { query: { path: 'logs' }, state: { profile: { name: 'research' } }, body: null }

    await runFileRoute('/api/hermes/files/list', ctx)

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

    const ctx: any = { query: { path: 'logs/app.log' }, state: { profile: { name: 'research' } }, body: null }

    await runFileRoute('/api/hermes/files/stat', ctx)

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

    const ctx: any = {
      request: { body: { path: 'workspace/weather.txt', recursive: false } },
      state: superAdminState(),
      body: null,
    }

    await runFileRoute('/api/hermes/files/delete', ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/weather.txt', 'research')
    expect(provider.deleteFile).toHaveBeenCalledWith('/home/agent/.hermes/workspace/weather.txt')
    expect(provider.deleteDir).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('returns missing_path instead of throwing when delete body is absent', async () => {
    const ctx: any = {
      request: { body: undefined },
      state: superAdminState(),
      body: null,
    }

    await runFileRoute('/api/hermes/files/delete', ctx)

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

    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: superAdminState(),
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}; charset=utf-8`
        : ''),
    }

    await runFileRoute('/api/hermes/files/upload', ctx)

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

    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: superAdminState(),
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}`
        : ''),
    }

    await runFileRoute('/api/hermes/files/upload', ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename', code: 'invalid_request' })
    expect(provider.writeFile).not.toHaveBeenCalled()
  })

  it('requires a super administrator for file editor content and mutations', async () => {
    const readCtx: any = {
      query: { path: 'workspace/weather.txt' },
      state: {
        profile: { name: 'research' },
        user: { id: 2, username: 'admin', role: 'admin' },
      },
      body: null,
    }

    await runFileRoute('/api/hermes/files/read', readCtx)

    expect(readCtx.status).toBe(403)
    expect(readCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(provider.readFile).not.toHaveBeenCalled()

    const writeCtx: any = {
      request: { body: { path: 'workspace/weather.txt', content: 'rain' } },
      state: {
        profile: { name: 'research' },
        user: { id: 2, username: 'admin', role: 'admin' },
      },
      body: null,
    }

    await runFileRoute('/api/hermes/files/write', writeCtx)

    expect(writeCtx.status).toBe(403)
    expect(writeCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(provider.writeFile).not.toHaveBeenCalled()
  })
})
