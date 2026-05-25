import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  listPreviews: vi.fn(async (ctx: any) => { ctx.body = { previews: [] } }),
  getPreview: vi.fn(async (ctx: any) => { ctx.body = { preview: { id: ctx.params.previewId } } }),
  startPreview: vi.fn(async (ctx: any) => { ctx.body = { preview: { id: 'preview-1' } } }),
  stopPreview: vi.fn(async (ctx: any) => { ctx.body = { preview: { id: ctx.params.previewId, status: 'stopped' } } }),
}

vi.mock('../../packages/server/src/controllers/hermes/previews', () => handlers)

describe('preview routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers generic preview lifecycle endpoints with super-admin protection', async () => {
    const { previewRoutes } = await import('../../packages/server/src/routes/hermes/previews')
    const paths = previewRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/previews',
      '/api/hermes/previews/:previewId',
      '/api/hermes/previews/:previewId/stop',
    ]))

    const layer: any = previewRoutes.stack.find((entry: any) => entry.path === '/api/hermes/previews')
    if (!layer) throw new Error('preview list route missing')
    expect(layer.stack).toHaveLength(2)

    const nonAdminCtx: any = { state: { user: { role: 'admin' } }, status: 0, body: null }
    const next = vi.fn(async () => {})
    await (layer.stack[0] as any)(nonAdminCtx, next)

    expect(nonAdminCtx.status).toBe(403)
    expect(nonAdminCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(next).not.toHaveBeenCalled()

    const superAdminCtx: any = { state: { user: { role: 'super_admin' } }, request: { body: {} }, status: 0, body: null }
    await (layer.stack[0] as any)(superAdminCtx, next)
    await (layer.stack[1] as any)(superAdminCtx)

    expect(handlers.listPreviews).toHaveBeenCalledWith(superAdminCtx)
    expect(superAdminCtx.body).toEqual({ previews: [] })
  })
})
