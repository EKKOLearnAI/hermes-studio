import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.fn(async (ctx: any) => {
  ctx.body = { plugins: [], warnings: [], metadata: {} }
})
const enableMock = vi.fn(async (ctx: any) => {
  ctx.body = { key: ctx.params.key, enabled: true }
})
const disableMock = vi.fn(async (ctx: any) => {
  ctx.body = { key: ctx.params.key, enabled: false }
})

vi.mock('../../packages/server/src/controllers/hermes/plugins', () => ({
  list: listMock,
  enable: enableMock,
  disable: disableMock,
}))

describe('plugin routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listMock.mockClear()
    enableMock.mockClear()
    disableMock.mockClear()
  })

  it('registers the plugins inventory and mutation routes', async () => {
    const { pluginRoutes } = await import('../../packages/server/src/routes/hermes/plugins')
    const paths = pluginRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/plugins',
      '/api/hermes/plugins/:key/enable',
      '/api/hermes/plugins/:key/disable',
    ]))
  })

  it('delegates plugin listing to the controller', async () => {
    const { pluginRoutes } = await import('../../packages/server/src/routes/hermes/plugins')
    const layer = pluginRoutes.stack.find((entry: any) => entry.path === '/api/hermes/plugins')
    const ctx: any = { body: null, params: {}, query: {} }

    await layer.stack[0](ctx)

    expect(listMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ plugins: [], warnings: [], metadata: {} })
  })

  it('delegates plugin enable and disable to the controller', async () => {
    const { pluginRoutes } = await import('../../packages/server/src/routes/hermes/plugins')
    const enableLayer = pluginRoutes.stack.find((entry: any) => entry.path === '/api/hermes/plugins/:key/enable')
    const disableLayer = pluginRoutes.stack.find((entry: any) => entry.path === '/api/hermes/plugins/:key/disable')
    const enableCtx: any = { body: null, params: { key: 'local-plugin' }, query: {} }
    const disableCtx: any = { body: null, params: { key: 'local-plugin' }, query: {} }

    await enableLayer.stack[0](enableCtx)
    await disableLayer.stack[0](disableCtx)

    expect(enableMock).toHaveBeenCalledWith(enableCtx)
    expect(disableMock).toHaveBeenCalledWith(disableCtx)
    expect(enableCtx.body).toEqual({ key: 'local-plugin', enabled: true })
    expect(disableCtx.body).toEqual({ key: 'local-plugin', enabled: false })
  })
})
