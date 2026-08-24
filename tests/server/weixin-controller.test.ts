import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

let hermesHome = ''
let studioHome = ''
const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const database = vi.hoisted(() => ({ value: null as any }))

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => database.value }))

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = studioHome
  return import('../../packages/server/src/controllers/social-messages')
}

function makeCtx(body: Record<string, any>, userId = 7, profile = 'research'): any {
  return {
    request: { body },
    state: { user: { id: userId }, profile: { name: profile } },
    status: 200,
    body: undefined,
  }
}

describe('social messages Weixin credentials', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { DatabaseSync } = await import('node:sqlite')
    database.value = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    hermesHome = await mkdtemp(join(tmpdir(), 'hwui-weixin-controller-'))
    studioHome = await mkdtemp(join(tmpdir(), 'studio-social-messages-'))
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
    database.value?.close()
    database.value = null
    vi.resetModules()
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (hermesHome) await rm(hermesHome, { recursive: true, force: true })
    if (studioHome) await rm(studioHome, { recursive: true, force: true })
    hermesHome = ''
    studioHome = ''
  })

  it('saves scanned Weixin credentials in Studio-owned storage without touching Hermes', async () => {
    const { saveWeixinCredentials } = await loadController()
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    const accountKey = createHash('sha256').update('new-research-account').digest('hex').slice(0, 24)
    store.writeSocialMessageRuntimeState(7, 'weixin', accountKey, {
      version: 1,
      accountId: 'new-research-account',
      syncBuf: 'stale-sync',
      peers: { 'stale-peer': { contextToken: 'stale-context', lastSeenAt: '2026-08-22T00:00:00.000Z' } },
    })
    const ctx = makeCtx({
      account_id: 'new-research-account',
      token: 'new-research-token',
      base_url: 'https://weixin.invalid',
      locale: 'zh',
    })

    await saveWeixinCredentials(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('WEIXIN_TOKEN=keep-default-token')
    const researchEnv = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')
    expect(researchEnv).toContain('OPENROUTER_API_KEY=keep-research-openrouter')
    expect(researchEnv).toContain('WEIXIN_ACCOUNT_ID=old-research-account')
    expect(researchEnv).toContain('WEIXIN_TOKEN=old-research-token')
    expect(store.getSocialMessageAccount(7, 'weixin')?.credentials).toEqual({
      accountId: 'new-research-account',
      token: 'new-research-token',
      baseUrl: 'https://weixin.invalid',
    })
    expect(store.getSocialMessageAccount(7, 'weixin')).toMatchObject({
      bindingLocale: 'zh',
      bindingNotified: false,
    })
    expect(store.readSocialMessageRuntimeState(7, 'weixin', accountKey)).toBeNull()
  })

  it('rejects missing required credentials without touching the Hermes profile env', async () => {
    const { saveWeixinCredentials } = await loadController()
    const ctx = makeCtx({ account_id: 'new-research-account' })
    const envBefore = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')

    await saveWeixinCredentials(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing account_id or token' })
    await expect(readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).resolves.toBe(envBefore)
  })

  it('saves manually entered Weixin credentials only for Social Messages', async () => {
    const { savePlatformCredentials } = await loadController()
    const { readStoredWeixinCredentials } = await import('../../packages/server/src/services/social-messages/credentials')
    const ctx = makeCtx({
      accountId: 'manual-social-account',
      token: 'manual-social-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    })
    ctx.params = { platform: 'weixin' }
    const hermesEnvBefore = await readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')

    await savePlatformCredentials(ctx)

    expect(ctx.body).toEqual({ success: true, platform: 'weixin' })
    await expect(readStoredWeixinCredentials(7)).resolves.toEqual({
      accountId: 'manual-social-account',
      token: 'manual-social-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    })
    await expect(readFile(join(hermesHome, 'profiles', 'research', '.env'), 'utf-8')).resolves.toBe(hermesEnvBefore)
  })

  it('shares credentials across profiles for one user and isolates different users', async () => {
    const { saveWeixinCredentials } = await loadController()
    const { readStoredWeixinCredentials } = await import('../../packages/server/src/services/social-messages/credentials')
    const researchCtx = makeCtx({ account_id: 'research-account', token: 'research-token' }, 7, 'research')
    const defaultCtx = makeCtx({ account_id: 'default-account', token: 'default-token' }, 7, 'default')
    const otherUserCtx = makeCtx({ account_id: 'other-account', token: 'other-token' }, 8, 'research')

    await saveWeixinCredentials(researchCtx)
    await saveWeixinCredentials(defaultCtx)
    await saveWeixinCredentials(otherUserCtx)

    expect(await readStoredWeixinCredentials(7)).toMatchObject({ accountId: 'default-account' })
    expect(await readStoredWeixinCredentials(8)).toMatchObject({ accountId: 'other-account' })
  })

  it('marks a configured account as the user’s only active push medium', async () => {
    const { saveWeixinCredentials, setActivePlatform } = await loadController()
    await saveWeixinCredentials(makeCtx({ account_id: 'active-account', token: 'active-token' }))

    const activeCtx = makeCtx({})
    activeCtx.params = { platform: 'weixin' }
    await setActivePlatform(activeCtx)

    expect(activeCtx.body).toEqual({ success: true, platform: 'weixin' })
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    expect(store.getActiveSocialMessageAccount(7)?.platform).toBe('weixin')

    const missingCtx = makeCtx({})
    missingCtx.params = { platform: 'telegram' }
    await setActivePlatform(missingCtx)
    expect(missingCtx.status).toBe(409)
  })

  it('updates the push locale without reconnecting or resetting the binding notification', async () => {
    const { saveWeixinCredentials, updatePlatformLocale } = await loadController()
    await saveWeixinCredentials(makeCtx({
      account_id: 'locale-account',
      token: 'locale-token',
      locale: 'zh',
    }))
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    expect(store.markSocialMessageBindingNotified(7, 'weixin')).toBe(true)

    const ctx = makeCtx({ locale: 'ja' })
    ctx.params = { platform: 'weixin' }
    await updatePlatformLocale(ctx)

    expect(ctx.body).toEqual({ success: true, platform: 'weixin', locale: 'ja' })
    expect(store.getSocialMessageAccount(7, 'weixin')).toMatchObject({
      bindingLocale: 'ja',
      bindingNotified: true,
      credentials: expect.objectContaining({ token: 'locale-token' }),
    })
  })

  it('clears Weixin credentials together with the saved runtime state', async () => {
    const { clearPlatformCredentials, saveWeixinCredentials } = await loadController()
    const { readStoredWeixinCredentials } = await import(
      '../../packages/server/src/services/social-messages/credentials'
    )
    const store = await import('../../packages/server/src/db/hermes/social-message-store')
    await saveWeixinCredentials(makeCtx({ account_id: 'clear-account', token: 'clear-token' }))

    const accountKey = createHash('sha256').update('clear-account').digest('hex').slice(0, 24)
    store.writeSocialMessageRuntimeState(7, 'weixin', accountKey, {
      version: 1,
      accountId: 'clear-account',
      syncBuf: 'saved-sync',
      peers: {},
    })

    const clearCtx = makeCtx({})
    clearCtx.params = { platform: 'weixin' }
    await clearPlatformCredentials(clearCtx)

    expect(clearCtx.body).toEqual({ success: true, platform: 'weixin' })
    await expect(readStoredWeixinCredentials(7)).resolves.toBeUndefined()
    expect(store.readSocialMessageRuntimeState(7, 'weixin', accountKey)).toBeNull()
  })
})
