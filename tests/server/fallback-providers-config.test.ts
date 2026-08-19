import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

const { mockGatewayAutostartDisabledByEnv, mockRestartGateway, mockReconcileGatewayManagement, mockDestroyProfile } = vi.hoisted(() => ({
  mockGatewayAutostartDisabledByEnv: vi.fn(() => false),
  mockRestartGateway: vi.fn().mockResolvedValue({ running: true, profile: 'default' }),
  mockReconcileGatewayManagement: vi.fn().mockResolvedValue({
    changed: false,
    previousUnified: false,
    nextUnified: false,
    stoppedProfiles: [],
    startedProfiles: [],
  }),
  mockDestroyProfile: vi.fn().mockResolvedValue({ destroyed: true }),
}))

vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => {
  return {
    gatewayAutostartDisabledByEnv: mockGatewayAutostartDisabledByEnv,
    reconcileGatewayManagementTransition: mockReconcileGatewayManagement,
    restartGatewayForProfile: mockRestartGateway,
  }
})

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: class {
    destroyProfile = mockDestroyProfile
  },
}))

const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/config')
}

function makeCtx(body: unknown, profile?: string): any {
  return {
    request: { body },
    query: {},
    state: profile ? { profile: { name: profile } } : {},
    get: vi.fn(() => ''),
    status: 200,
    body: undefined,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockGatewayAutostartDisabledByEnv.mockReturnValue(false)
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

/**
 * Hermes reads `fallback_providers` straight out of the profile's config.yaml
 * and hands the chain to the agent when a session starts, so these assert the
 * bytes on disk, not just the API response.
 */
describe('fallback providers config', () => {
  it('writes the chain to config.yaml in the order Hermes will try it', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: glm-5.1\n', 'utf-8')
    const { updateFallbackProviders, getFallbackProviders } = await loadController()
    const ctx = makeCtx({
      fallback_providers: [
        { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
        { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      ],
    })

    await updateFallbackProviders(ctx)

    expect(ctx.body.success).toBe(true)
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.fallback_providers).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
      { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    ])
    // Unrelated settings survive the write.
    expect(config.model.default).toBe('glm-5.1')

    const readCtx = makeCtx(undefined)
    await getFallbackProviders(readCtx)
    expect(readCtx.body.fallback_providers).toEqual(config.fallback_providers)
  })

  it('drops entries Hermes would ignore and repeats that could never fire', async () => {
    const { updateFallbackProviders } = await loadController()
    const ctx = makeCtx({
      fallback_providers: [
        { provider: 'openrouter', model: ' anthropic/claude-sonnet-4 ' },
        { provider: 'openrouter' },
        { model: 'gpt-5.6-sol' },
        { provider: '  ', model: 'gpt-5.6-sol' },
        'not-an-entry',
        { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
      ],
    })

    await updateFallbackProviders(ctx)

    expect(ctx.body.fallback_providers).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    ])
  })

  it('removes the key entirely when the chain is emptied', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: glm-5.1',
      'fallback_providers:',
      '  - provider: openrouter',
      '    model: anthropic/claude-sonnet-4',
      '',
    ].join('\n'), 'utf-8')
    const { updateFallbackProviders } = await loadController()

    await updateFallbackProviders(makeCtx({ fallback_providers: [] }))

    const raw = await readFile(join(hermesHome, 'config.yaml'), 'utf-8')
    // Not `fallback_providers: []` left behind for Hermes to parse.
    expect(raw).not.toContain('fallback_providers')
    expect((YAML.load(raw) as any).model.default).toBe('glm-5.1')
  })

  it('writes to the requested profile rather than the active one', async () => {
    const profileDir = join(hermesHome, 'profiles', 'work')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: glm-5.1\n', 'utf-8')
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: glm-5.1\n', 'utf-8')
    const { updateFallbackProviders } = await loadController()

    await updateFallbackProviders(makeCtx({
      fallback_providers: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }],
    }, 'work'))

    const scoped = YAML.load(await readFile(join(profileDir, 'config.yaml'), 'utf-8')) as any
    const active = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(scoped.fallback_providers).toHaveLength(1)
    expect(active.fallback_providers).toBeUndefined()
  })

  it('rejects a body that is not a list', async () => {
    const { updateFallbackProviders } = await loadController()
    const ctx = makeCtx({ fallback_providers: { provider: 'openrouter', model: 'x' } })

    await updateFallbackProviders(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing fallback_providers list' })
  })
})
