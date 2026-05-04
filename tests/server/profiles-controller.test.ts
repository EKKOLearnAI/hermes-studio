import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadProfilesController(options?: {
  profiles?: Array<{ name: string; active: boolean; model?: string; gateway?: string; alias?: string }>
  activeProfile?: string | null
}) {
  vi.resetModules()

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    listProfiles: vi.fn().mockResolvedValue(options?.profiles ?? []),
  }))

  vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn(() => {
      if (options?.activeProfile === undefined) return null
      return {
        getActiveProfile: () => options.activeProfile,
      }
    }),
  }))

  return import('../../packages/server/src/controllers/hermes/profiles')
}

function createMockCtx() {
  return {
    status: 200,
    body: null as any,
  }
}

describe('profiles controller list()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('overrides stale active flags using GatewayManager active profile', async () => {
    const { list } = await loadProfilesController({
      profiles: [
        { name: 'default', active: true, model: 'gpt-5.4', gateway: 'running', alias: '' },
        { name: 'secondary', active: false, model: 'gpt-5.4', gateway: 'running', alias: 'secondary' },
      ],
      activeProfile: 'secondary',
    })
    const ctx = createMockCtx()

    await list(ctx)

    expect(ctx.body).toEqual({
      profiles: [
        { name: 'default', active: false, model: 'gpt-5.4', gateway: 'running', alias: '' },
        { name: 'secondary', active: true, model: 'gpt-5.4', gateway: 'running', alias: 'secondary' },
      ],
    })
  })

  it('keeps CLI flags unchanged when no gateway manager is available', async () => {
    const { list } = await loadProfilesController({
      profiles: [
        { name: 'default', active: true, model: 'gpt-5.4', gateway: 'running', alias: '' },
        { name: 'secondary', active: false, model: 'gpt-5.4', gateway: 'running', alias: 'secondary' },
      ],
    })
    const ctx = createMockCtx()

    await list(ctx)

    expect(ctx.body).toEqual({
      profiles: [
        { name: 'default', active: true, model: 'gpt-5.4', gateway: 'running', alias: '' },
        { name: 'secondary', active: false, model: 'gpt-5.4', gateway: 'running', alias: 'secondary' },
      ],
    })
  })
})
