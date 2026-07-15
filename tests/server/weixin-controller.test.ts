import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { mockGatewayAutostartDisabledByEnv, mockRestartGatewayForProfile } = vi.hoisted(() => ({
  mockGatewayAutostartDisabledByEnv: vi.fn(() => false),
  mockRestartGatewayForProfile: vi.fn().mockResolvedValue({ running: true, profile: 'research' }),
}))

vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => ({
  gatewayAutostartDisabledByEnv: mockGatewayAutostartDisabledByEnv,
  restartGatewayForProfile: mockRestartGatewayForProfile,
}))

let hermesHome = ''
const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/weixin')
}

function makeCtx(body: Record<string, any>, profile = 'research'): any {
  return {
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined,
  }
}

describe('weixin controller', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockGatewayAutostartDisabledByEnv.mockReturnValue(false)
    hermesHome = await mkdtemp(join(tmpdir(), 'hwui-weixin-controller-'))
    await mkdir(join(hermesHome, 'profiles', 'research'), { recursive: true })
    await writeFile(join(hermesHome, '.env'), [
      'WEIXIN_ACCOUNT_ID=keep-default-account',
      'WEIXIN_TOKEN=keep-default-token',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, 'profiles', 'research', '.env'), [
      'OPENROUTER_API_KEY=keep-research-openrouter',
      'WEIXIN_ACCOUNT_ID=old-research-account',
      'WEIXIN_TOKEN=old-research-token',
      '',
    ].join('\n'), 'utf-8')
  })

  afterEach(async () => {
    vi.resetModules()
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (hermesHome) await rm(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('saves scanned Weixin credentials to the request-scoped profile env only', async () => {
    const { save } = await loadController()
    const ctx = makeCtx({
      account_id: 'new-research-account',
      token: 'new-research-token',
      base_url: 'https://weixin.invalid',
    })

    await save(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGatewayForProfile).toHaveBeenCalledWith('research')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('WEIXIN_TOKEN=keep-default-token')
    const researchEnv = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')
    expect(researchEnv).toContain('OPENROUTER_API_KEY=keep-research-openrouter')
    expect(researchEnv).toContain('WEIXIN_ACCOUNT_ID=new-research-account')
    expect(researchEnv).toContain('WEIXIN_TOKEN=new-research-token')
    expect(researchEnv).toContain('WEIXIN_BASE_URL=https://weixin.invalid')
  })

  it('rejects missing required credentials without touching the profile env', async () => {
    const { save } = await loadController()
    const ctx = makeCtx({ account_id: 'new-research-account' })
    const envBefore = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')

    await save(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing account_id or token' })
    expect(mockRestartGatewayForProfile).not.toHaveBeenCalled()
    await expect(readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).resolves.toBe(envBefore)
  })

  it('saves scanned Weixin credentials without restarting when gateway auto-start is disabled', async () => {
    await writeFile(join(hermesHome, 'config.json'), JSON.stringify({
      gatewayAutoStart: { enabled: false },
    }), 'utf-8')
    const { save } = await loadController()
    const ctx = makeCtx({
      account_id: 'new-research-account',
      token: 'new-research-token',
    })

    await save(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGatewayForProfile).not.toHaveBeenCalled()
    const researchEnv = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')
    expect(researchEnv).toContain('WEIXIN_ACCOUNT_ID=new-research-account')
    expect(researchEnv).toContain('WEIXIN_TOKEN=new-research-token')
  })
})
