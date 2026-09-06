import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { probe, catalog, write } = vi.hoisted(() => ({
  probe: vi.fn(), catalog: vi.fn(), write: vi.fn(),
}))
vi.mock('node:util', () => ({ promisify: () => probe }))
vi.mock('../../packages/server/src/modules/hermes/services/runtime/installation', () => ({ resolveHermesInstallationEnvironment: () => ({ python: '/runtime/python', agentRoot: '/runtime' }) }))
vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({ resolveHermesBin: () => '/runtime/hermes' }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getProfileDir: () => '/profiles' }))
vi.mock('../../packages/server/src/modules/studio/public/provider-catalog', () => ({ fetchOpenCodeFreeModels: catalog }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache', () => ({ writeProviderModelCatalogEntry: write }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))

beforeEach(() => {
  vi.stubEnv('HERMES_AGENT_BRIDGE_PYTHON', '/runtime/python')
  vi.stubEnv('HERMES_AGENT_ROOT', '/runtime')
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  probe.mockResolvedValue({ stdout: 'supported\n' })
  catalog.mockResolvedValue(['mimo-v2.5-free'])
  write.mockResolvedValue({})
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

describe('OpenCode Free background initialization', () => {
  it('returns immediately, deduplicates slow requests and persists only the public catalog', async () => {
    let finish!: (models: string[]) => void
    catalog.mockImplementation(() => new Promise<string[]>(resolve => { finish = resolve }))
    const service = await import('../../packages/server/src/modules/hermes/services/providers/opencode-free')
    expect(service.initializeOpenCodeFreeInBackground()).toBeUndefined()
    service.initializeOpenCodeFreeInBackground()
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog).toHaveBeenCalledTimes(1)
    expect(service.getOpenCodeFreeStatus()).toBe('loading')
    expect(write).not.toHaveBeenCalled()
    expect(probe.mock.calls[0][0]).toBe('/runtime/python')
    expect(probe.mock.calls[0][2].timeout).toBe(5000)
    expect(probe.mock.calls[0][2].cwd).toBe('/runtime')
    finish(['mimo-v2.5-free'])
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getOpenCodeFreeStatus()).toBe('ready')
    expect(write).toHaveBeenCalledWith({ provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', models: ['mimo-v2.5-free'], source: 'live' })
    service.initializeOpenCodeFreeInBackground()
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('keeps the last-good cache on timeout and retries later without a busy loop', async () => {
    catalog.mockRejectedValueOnce(new Error('timeout'))
    const service = await import('../../packages/server/src/modules/hermes/services/providers/opencode-free')
    service.initializeOpenCodeFreeInBackground()
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getOpenCodeFreeStatus()).toBe('error')
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(catalog).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(service.getOpenCodeFreeStatus()).toBe('ready')
  })

  it('reports older Hermes installations without changing their model config', async () => {
    probe.mockResolvedValue({ stdout: 'unsupported\n' })
    const service = await import('../../packages/server/src/modules/hermes/services/providers/opencode-free')
    service.initializeOpenCodeFreeInBackground()
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getOpenCodeFreeStatus()).toBe('unsupported')
  })

  it('does not replace a good catalog with an empty response', async () => {
    catalog.mockResolvedValue([])
    const service = await import('../../packages/server/src/modules/hermes/services/providers/opencode-free')
    service.initializeOpenCodeFreeInBackground()
    await vi.advanceTimersByTimeAsync(0)
    expect(write).not.toHaveBeenCalled()
    expect(service.getOpenCodeFreeStatus()).toBe('error')
  })
})
