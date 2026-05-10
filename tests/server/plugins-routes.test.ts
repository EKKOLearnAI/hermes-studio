import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.fn(async (ctx: any) => {
  ctx.body = { plugins: [], warnings: [], metadata: {} }
})

vi.mock('../../packages/server/src/controllers/hermes/plugins', () => ({
  list: listMock,
}))

describe('plugin routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listMock.mockClear()
  })

  it('registers the plugins inventory route', async () => {
    const { pluginRoutes } = await import('../../packages/server/src/routes/hermes/plugins')
    const paths = pluginRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining(['/api/hermes/plugins']))
  })

  it('delegates plugin listing to the controller', async () => {
    const { pluginRoutes } = await import('../../packages/server/src/routes/hermes/plugins')
    const layer = pluginRoutes.stack.find((entry: any) => entry.path === '/api/hermes/plugins')
    const ctx: any = { body: null, params: {}, query: {} }

    await layer.stack[0](ctx)

    expect(listMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ plugins: [], warnings: [], metadata: {} })
  })
})
