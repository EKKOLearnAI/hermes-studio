import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

const { mockRestartGateway, mockDestroyProfile } = vi.hoisted(() => ({
  mockRestartGateway: vi.fn().mockResolvedValue({ running: true, profile: 'default' }),
  mockDestroyProfile: vi.fn().mockResolvedValue({ destroyed: true }),
}))

vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => {
  return {
    restartGatewayForProfile: mockRestartGateway,
  }
})

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: class {
    destroyProfile = mockDestroyProfile
  },
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/config')
}

function makeCtx(body: unknown, profile?: string): any {
  return {
    request: { body },
    query: {},
    state: profile ? { profile: { name: profile } } : {},
    status: 200,
    body: undefined,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

describe('config controller locked file updates', () => {
  it('deep merges a config section and restarts the gateway through hermes-cli', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  enabled: false',
      '  extra:',
      '    mode: old',
      'model:',
      '  default: glm-5.1',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig } = await loadController()
    const ctx = makeCtx({ section: 'telegram', values: { enabled: true, extra: { token_mode: 'env' } } })

    await updateConfig(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).toHaveBeenCalledWith('default')
    expect(mockDestroyProfile).not.toHaveBeenCalled()
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.telegram.enabled).toBe(true)
    expect(config.telegram.extra).toEqual({ mode: 'old', token_mode: 'env' })
    expect(config.model.default).toBe('glm-5.1')
  })

  it('clears credential env values and removes matching config fields without losing unrelated env keys', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  weixin:',
      '    token: old-token',
      '    extra:',
      '      account_id: old-account',
      '      base_url: https://old.example',
      'model:',
      '  default: glm-5.1',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'OPENROUTER_API_KEY=keep',
      'WEIXIN_TOKEN=old-token',
      'WEIXIN_ACCOUNT_ID=old-account',
      '',
    ].join('\n'), 'utf-8')
    const { updateCredentials } = await loadController()
    const ctx = makeCtx({ platform: 'weixin', values: { token: '', extra: { account_id: '', base_url: 'https://new.example' } } })

    await updateCredentials(ctx)

    expect(ctx.body).toEqual({ success: true })
    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).not.toContain('WEIXIN_TOKEN=')
    expect(env).not.toContain('WEIXIN_ACCOUNT_ID=')
    expect(env).toContain('WEIXIN_BASE_URL=https://new.example')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.weixin.token).toBeUndefined()
    expect(config.platforms.weixin.extra.account_id).toBeUndefined()
    expect(config.platforms.weixin.extra.base_url).toBe('https://old.example')
    expect(config.model.default).toBe('glm-5.1')
  })

  it('writes QQBot credentials to env and overlays them into platform config reads', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  qqbot:',
      '    extra:',
      '      markdown_support: true',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'qqbot',
      values: {
        extra: { app_id: 'qq-app', client_secret: 'qq-secret' },
        allowed_users: 'user-1,user-2',
        allow_all_users: false,
      },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('QQ_APP_ID=qq-app')
    expect(env).toContain('QQ_CLIENT_SECRET=qq-secret')
    expect(env).toContain('QQ_ALLOWED_USERS=user-1,user-2')
    expect(env).toContain('QQ_ALLOW_ALL_USERS=false')

    const ctx = makeCtx({})
    await getConfig(ctx)
    expect(ctx.body.platforms.qqbot.extra.app_id).toBe('qq-app')
    expect(ctx.body.platforms.qqbot.extra.client_secret).toBe('qq-secret')
    expect(ctx.body.platforms.qqbot.extra.markdown_support).toBe(true)
    expect(ctx.body.platforms.qqbot.allowed_users).toBe('user-1,user-2')
    expect(ctx.body.platforms.qqbot.allow_all_users).toBe(false)
  })

  it('reads and writes channel settings in the request-scoped profile only', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  require_mention: false',
      'model:',
      '  default: keep-default-model',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'TELEGRAM_BOT_TOKEN=keep-default-token',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'telegram:',
      '  require_mention: false',
      'model:',
      '  default: research-model',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, '.env'), [
      'TELEGRAM_BOT_TOKEN=old-research-token',
      '',
    ].join('\n'), 'utf-8')

    const { updateConfig, updateCredentials, getConfig } = await loadController()

    await updateConfig(makeCtx({
      section: 'telegram',
      values: { require_mention: true, free_response_chats: 'chat-1' },
    }, 'research'))
    await updateCredentials(makeCtx({
      platform: 'telegram',
      values: { token: 'new-research-token' },
    }, 'research'))

    expect(mockRestartGateway).toHaveBeenCalledWith('research')
    expect(mockDestroyProfile).not.toHaveBeenCalled()
    const defaultConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(defaultConfig.telegram.require_mention).toBe(false)
    expect(researchConfig.telegram.require_mention).toBe(true)
    expect(researchConfig.telegram.free_response_chats).toBe('chat-1')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=keep-default-token')
    expect(await readFile(join(researchDir, '.env'), 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=new-research-token')

    const ctx = makeCtx({}, 'research')
    await getConfig(ctx)
    expect(ctx.body.platforms.telegram.token).toBe('new-research-token')
    expect(ctx.body.telegram.require_mention).toBe(true)
  })
})
