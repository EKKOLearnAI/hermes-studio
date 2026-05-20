import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = {
  listDir: vi.fn(),
  stat: vi.fn(),
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
  })

  it('returns absolute paths for listed entries while preserving relative operation paths', async () => {
    provider.listDir.mockResolvedValue([
      { name: 'app.log', path: 'logs/app.log', isDir: false, size: 12, modTime: '2026-05-20T00:00:00.000Z' },
    ])

    const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
    const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/list')
    const ctx: any = { query: { path: 'logs' }, body: null }

    await layer.stack[0](ctx)

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
    const ctx: any = { query: { path: 'logs/app.log' }, body: null }

    await layer.stack[0](ctx)

    expect(ctx.body).toEqual({
      name: 'app.log',
      path: 'logs/app.log',
      absolutePath: '/home/agent/.hermes/logs/app.log',
      isDir: false,
      size: 12,
      modTime: '2026-05-20T00:00:00.000Z',
    })
  })
})
