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


  it('reads and writes gateway auto-start policy from Web UI app config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: keep-model',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig, getConfig } = await loadController()

    const writeCtx = makeCtx({
      section: 'gatewayAutoStart',
      values: {
        enabled: true,
        include: ['default', ' reviewer ', '', 'default'],
        exclude: ['scratch', ' missing '],
      },
    })
    await updateConfig(writeCtx)

    expect(writeCtx.body).toEqual({
      success: true,
      gatewayAutoStart: {
        enabled: true,
        include: ['default', 'reviewer'],
        exclude: ['scratch', 'missing'],
      },
    })
    expect(mockRestartGateway).not.toHaveBeenCalled()

    const persisted = JSON.parse(await readFile(join(hermesHome, 'config.json'), 'utf-8'))
    expect(persisted.gatewayAutoStart).toEqual({
      enabled: true,
      include: ['default', 'reviewer'],
      exclude: ['scratch', 'missing'],
    })
    const yamlConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(yamlConfig.gatewayAutoStart).toBeUndefined()
    expect(yamlConfig.model.default).toBe('keep-model')

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.gatewayAutoStart).toEqual({
      enabled: true,
      include: ['default', 'reviewer'],
      exclude: ['scratch', 'missing'],
    })
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

  it('round-trips Feishu webhook credentials through env-backed platform settings', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  feishu:',
      '    extra:',
      '      mode: webhook',
      '      app_id: old-config-app',
      '      encrypt_key: old-config-encrypt',
      '      verification_token: old-config-verify',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'feishu',
      values: {
        extra: {
          app_id: 'cli_test_app',
          app_secret: 'feishu-secret',
          encrypt_key: 'feishu-encrypt',
          verification_token: 'feishu-verify',
        },
      },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('FEISHU_APP_ID=cli_test_app')
    expect(env).toContain('FEISHU_APP_SECRET=feishu-secret')
    expect(env).toContain('FEISHU_ENCRYPT_KEY=feishu-encrypt')
    expect(env).toContain('FEISHU_VERIFICATION_TOKEN=feishu-verify')

    const migratedConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(migratedConfig.platforms.feishu.extra.mode).toBe('webhook')
    expect(migratedConfig.platforms.feishu.extra.app_id).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.app_secret).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.encrypt_key).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.verification_token).toBeUndefined()

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.platforms.feishu.extra.mode).toBe('webhook')
    expect(readCtx.body.platforms.feishu.extra.app_id).toBe('cli_test_app')
    expect(readCtx.body.platforms.feishu.extra.app_secret).toBe('feishu-secret')
    expect(readCtx.body.platforms.feishu.extra.encrypt_key).toBe('feishu-encrypt')
    expect(readCtx.body.platforms.feishu.extra.verification_token).toBe('feishu-verify')

    await updateCredentials(makeCtx({
      platform: 'feishu',
      values: {
        extra: {
          app_id: '',
          app_secret: '',
          encrypt_key: '',
          verification_token: '',
        },
      },
    }))

    const clearedEnv = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(clearedEnv).toContain('OPENROUTER_API_KEY=keep')
    expect(clearedEnv).not.toContain('FEISHU_APP_ID=')
    expect(clearedEnv).not.toContain('FEISHU_APP_SECRET=')
    expect(clearedEnv).not.toContain('FEISHU_ENCRYPT_KEY=')
    expect(clearedEnv).not.toContain('FEISHU_VERIFICATION_TOKEN=')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.feishu.extra.mode).toBe('webhook')
    expect(config.platforms.feishu.extra.app_id).toBeUndefined()
    expect(config.platforms.feishu.extra.app_secret).toBeUndefined()
    expect(config.platforms.feishu.extra.encrypt_key).toBeUndefined()
    expect(config.platforms.feishu.extra.verification_token).toBeUndefined()
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

  it('reads and replaces auxiliary model settings in the requested profile', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: root-model',
      'auxiliary:',
      '  compression:',
      '    provider: openrouter',
      '    model: root-compressor',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'model:',
      '  default: research-model',
      'auxiliary:',
      '  vision:',
      '    provider: main',
      '  web_extract:',
      '    provider: auto',
      '    base_url: keep-visible-base-url',
      '    api_key: keep-visible-api-key',
      '',
    ].join('\n'), 'utf-8')

    const { getAuxiliaryModels, updateAuxiliaryModels } = await loadController()
    const readCtx = makeCtx({})
    readCtx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await getAuxiliaryModels(readCtx)

    expect(readCtx.body.auxiliary).toEqual({
      vision: { provider: 'main' },
      web_extract: {
        provider: 'auto',
        base_url: 'keep-visible-base-url',
        api_key: 'keep-visible-api-key',
      },
    })
    expect(readCtx.body.tasks.some((task: any) => task.key === 'compression' && task.default_timeout === 120)).toBe(true)
    expect(readCtx.body.tasks.some((task: any) => task.key === 'vision' && task.default_download_timeout === 30)).toBe(true)

    const writeCtx = makeCtx({
      auxiliary: {
        compression: {
          provider: ' openrouter ',
          model: ' google/gemini-3-flash-preview ',
          timeout: 120.7,
          download_timeout: 30,
          extra_body: { temperature: 0 },
          ignored: 'drop',
        },
        empty_task: {
          provider: 'auto',
          model: 'drop-model',
          base_url: 'drop-base-url',
          api_key: 'drop-api-key',
          extra_body: { should: 'drop' },
          timeout: 30,
        },
        blank_task: {
          provider: '',
          model: '',
        },
      },
    })
    writeCtx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await updateAuxiliaryModels(writeCtx)

    expect(writeCtx.body).toEqual({
      success: true,
      auxiliary: {
        compression: {
          provider: 'openrouter',
          model: 'google/gemini-3-flash-preview',
          timeout: 120,
          extra_body: { temperature: 0 },
        },
        empty_task: {
          provider: 'auto',
          timeout: 30,
        },
      },
    })
    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.auxiliary.compression.model).toBe('root-compressor')
    expect(researchConfig.model.default).toBe('research-model')
    expect(researchConfig.auxiliary).toEqual({
      compression: {
        provider: 'openrouter',
        model: 'google/gemini-3-flash-preview',
        timeout: 120,
        extra_body: { temperature: 0 },
      },
      empty_task: {
        provider: 'auto',
        timeout: 30,
      },
    })
  })
})
