import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { status } = vi.hoisted(() => ({ status: vi.fn(() => 'loading') }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/opencode-free', () => ({ getOpenCodeFreeStatus: status }))
let home = ''
let appHome = ''
const originalHome = process.env.HERMES_HOME
const originalAppHome = process.env.HERMES_WEB_UI_HOME
const initialConfig = 'model:\n  provider: deepseek\n  default: deepseek-chat\n'
beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'opencode-free-profile-'))
  appHome = mkdtempSync(join(tmpdir(), 'opencode-free-studio-'))
  process.env.HERMES_HOME = home
  process.env.HERMES_WEB_UI_HOME = appHome
  writeFileSync(join(home, 'config.yaml'), initialConfig)
  writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=test-key\n')
  status.mockReturnValue('loading')
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHome
  if (originalAppHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalAppHome
  rmSync(home, { recursive: true, force: true })
  rmSync(appHome, { recursive: true, force: true })
})

async function load() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const models = await import('../../packages/server/src/modules/hermes/controllers/models')
  const cache = await import('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache')
  return { ...models, ...cache }
}
const ctx = () => ({ query: { profile: 'default' }, body: undefined as any })

describe('OpenCode Free provider discovery', () => {
  it('shows the loading entry immediately without waiting for network or modifying the default', async () => {
    const { getAvailable } = await load()
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups).toContainEqual(expect.objectContaining({ provider: 'opencode-free', api_key: '', models: [], catalog_status: 'loading' }))
    expect(request.body.default_provider).toBe('deepseek')
    expect(request.body.default).toBe('deepseek-chat')
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(initialConfig)
  })

  it('uses the public cache during a failed refresh and filters out paid models', async () => {
    const { getAvailable, writeProviderModelCatalogEntry } = await load()
    await writeProviderModelCatalogEntry({ provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', models: ['mimo-v2.5-free', 'paid-model'], source: 'live' })
    status.mockReturnValue('error')
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups).toContainEqual(expect.objectContaining({ provider: 'opencode-free', models: ['mimo-v2.5-free'], catalog_status: 'error' }))
    expect(request.body.default_provider).toBe('deepseek')
  })

  it('keeps the entry but disables models when Hermes lacks the provider', async () => {
    const { getAvailable, writeProviderModelCatalogEntry } = await load()
    await writeProviderModelCatalogEntry({ provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', models: ['mimo-v2.5-free'], source: 'live' })
    status.mockReturnValue('unsupported')
    const request = ctx()
    await getAvailable(request)
    expect(request.body.groups).toContainEqual(expect.objectContaining({ provider: 'opencode-free', models: [], catalog_status: 'unsupported' }))
  })
})
