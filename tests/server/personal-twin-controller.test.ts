import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = {
  getPersonalTwinOverview: vi.fn(() => ({ subject: { id: 'person:self' } })),
  listTwinEntities: vi.fn(() => []),
  listTwinObservations: vi.fn(() => []),
  listTwinEvents: vi.fn(() => []),
  getPersonalTwinContext: vi.fn(() => ({ observations: [], events: [] })),
  syncLegacyTwinSources: vi.fn(() => ({ status: 'completed' })),
}

vi.mock('../../packages/server/src/services/hermes/personal-twin', () => service)

describe('personal twin controller', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(service).forEach(fn => fn.mockClear())
  })

  it('returns global overview without forwarding a profile selector', async () => {
    const { overview } = await import('../../packages/server/src/controllers/hermes/personal-twin')
    const ctx: any = { query: { profile: 'coach' }, request: { body: {} }, state: { user: { id: 'local', role: 'super_admin' } }, body: null }
    await overview(ctx)
    expect(service.getPersonalTwinOverview).toHaveBeenCalledWith()
    expect(ctx.body).toEqual({ overview: { subject: { id: 'person:self' } } })
  })

  it('parses bounded filters and comma-separated context domains', async () => {
    const { entities, observations, events, context } = await import('../../packages/server/src/controllers/hermes/personal-twin')
    const base: any = { state: { user: { role: 'super_admin' } }, request: { body: {} }, body: null }
    await entities({ ...base, query: { type: 'person', source: 'system', limit: '20' } } as any)
    await observations({ ...base, query: { entityId: 'person:self', metric: 'body.weight_kg', limit: '30' } } as any)
    await events({ ...base, query: { subjectId: 'person:self', eventType: 'health.scale.measured', limit: '10' } } as any)
    await context({ ...base, query: { domains: 'body, health', query: 'weight', limit: '25' } } as any)
    expect(service.listTwinEntities).toHaveBeenCalledWith({ type: 'person', source: 'system', limit: 20 })
    expect(service.listTwinObservations).toHaveBeenCalledWith({ entityId: 'person:self', metric: 'body.weight_kg', limit: 30 })
    expect(service.listTwinEvents).toHaveBeenCalledWith({ subjectId: 'person:self', eventType: 'health.scale.measured', limit: 10 })
    expect(service.getPersonalTwinContext).toHaveBeenCalledWith({ domains: ['body', 'health'], query: 'weight', limit: 25 })
  })

  it('normalizes legacy import profiles and rejects malformed bodies', async () => {
    const { importLegacy } = await import('../../packages/server/src/controllers/hermes/personal-twin')
    const ctx: any = { state: { user: { role: 'super_admin' } }, query: {}, request: { body: { profiles: [' default ', 'coach', ''] } }, body: null }
    await importLegacy(ctx)
    expect(service.syncLegacyTwinSources).toHaveBeenCalledWith({ profiles: ['default', 'coach'] })
    expect(ctx.body).toEqual({ result: { status: 'completed' } })

    const malformed: any = { state: { user: { role: 'super_admin' } }, query: {}, request: { body: { profiles: 'default' } }, body: null }
    await importLegacy(malformed)
    expect(malformed.status).toBe(400)
  })
})
