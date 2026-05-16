import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

const { mockGatewayManager } = vi.hoisted(() => ({
  mockGatewayManager: {
    getActiveProfile: vi.fn(() => 'default'),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => mockGatewayManager,
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/config')
}

function makeCtx(body: unknown): any {
  return { request: { body }, query: {}, status: 200, body: undefined }
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
  it('deep merges a config section and restarts platform gateways', async () => {
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
    expect(mockGatewayManager.stop).toHaveBeenCalledWith('default')
    expect(mockGatewayManager.start).toHaveBeenCalledWith('default')
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
})
