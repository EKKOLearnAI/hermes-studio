import { beforeEach, describe, expect, it, vi } from 'vitest'

const summaryMock = vi.fn(async (ctx: any) => {
  ctx.body = { root: '/repo', languages: {}, manifests: [], capabilities: {}, recommendedSkills: [], generatedAt: '2026-05-20T00:00:00.000Z' }
})

vi.mock('../../packages/server/src/controllers/hermes/code-intelligence', () => ({
  summary: summaryMock,
}))

describe('code intelligence routes', () => {
  beforeEach(() => {
    vi.resetModules()
    summaryMock.mockClear()
  })

  it('registers the summary route', async () => {
    const { codeIntelligenceRoutes } = await import('../../packages/server/src/routes/hermes/code-intelligence')
    const paths = codeIntelligenceRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining(['/api/hermes/code-intelligence/summary']))
  })

  it('delegates summary requests to the controller', async () => {
    const { codeIntelligenceRoutes } = await import('../../packages/server/src/routes/hermes/code-intelligence')
    const layer = codeIntelligenceRoutes.stack.find((entry: any) => entry.path === '/api/hermes/code-intelligence/summary')
    const ctx: any = { body: null, params: {}, query: {} }

    await layer.stack[0](ctx)

    expect(summaryMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body.root).toBe('/repo')
  })
})
