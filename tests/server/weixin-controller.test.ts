import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRestartGateway } = vi.hoisted(() => ({
  mockRestartGateway: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  restartGateway: mockRestartGateway,
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/weixin')
}

function makeCtx(body: unknown): any {
  return { request: { body }, status: 200, body: undefined }
}

beforeEach(async () => {
  vi.clearAllMocks()
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-weixin-controller-'))
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

describe('weixin controller save', () => {
  it('updates .env through the locked file store and preserves unrelated keys', async () => {
    await writeFile(join(hermesHome, '.env'), [
      'OPENROUTER_API_KEY=keep',
      'WEIXIN_TOKEN=old-token',
      '',
    ].join('\n'), 'utf-8')
    const { save } = await loadController()
    const ctx = makeCtx({ account_id: 'acct-1', token: 'new-token', base_url: 'https://weixin.local' })

    await save(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).toHaveBeenCalled()
    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('WEIXIN_ACCOUNT_ID=acct-1')
    expect(env).toContain('WEIXIN_TOKEN=new-token')
    expect(env).toContain('WEIXIN_BASE_URL=https://weixin.local')
    expect(env).not.toContain('old-token')
  })

  it('rejects missing required credentials without touching .env', async () => {
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { save } = await loadController()
    const ctx = makeCtx({ account_id: 'acct-1' })

    await save(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing account_id or token' })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    await expect(readFile(join(hermesHome, '.env'), 'utf-8')).resolves.toBe('OPENROUTER_API_KEY=keep\n')
  })
})
