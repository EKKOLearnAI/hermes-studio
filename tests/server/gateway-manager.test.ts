import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME
const originalEnv = { ...process.env }
const tempHomes: string[] = []

function createHermesHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-gateway-'))
  tempHomes.push(home)
  return home
}

async function createManager(home: string): Promise<any> {
  process.env.HERMES_HOME = home
  vi.resetModules()
  const { GatewayManager } = await import('../../packages/server/src/services/hermes/gateway-manager')
  return new GatewayManager('default') as any
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
  if (originalHermesHome === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = originalHermesHome
  }

  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('GatewayManager Windows process recovery', () => {
  it('treats EPERM from process.kill(pid, 0) as an alive process', async () => {
    const manager = await createManager(createHermesHome())
    ;(vi.spyOn(process, 'kill') as any).mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })

    expect(manager.isProcessAlive(12345)).toBe(true)
  })

  it('returns false for missing processes', async () => {
    const manager = await createManager(createHermesHome())
    ;(vi.spyOn(process, 'kill') as any).mockImplementation(() => {
      const error = new Error('missing process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })

    expect(manager.isProcessAlive(12345)).toBe(false)
  })

  it('prefers gateway.pid when PID metadata exists', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: 11111 }))
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 22222, gateway_state: 'running' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBe(11111)
  })

  it('falls back to gateway_state.json when gateway.pid is missing', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: '22222', gateway_state: 'running' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBe(22222)
  })

  it('does not use gateway_state.json for stopped gateways', async () => {
    const home = createHermesHome()
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 22222, gateway_state: 'stopped' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('default')).toBeNull()
  })

  it('uses profile-scoped gateway_state.json fallback', async () => {
    const home = createHermesHome()
    const profileHome = join(home, 'profiles', 'work')
    mkdirSync(profileHome, { recursive: true })
    writeFileSync(join(profileHome, 'gateway_state.json'), JSON.stringify({ pid: 33333, gateway_state: 'starting' }))

    const manager = await createManager(home)

    expect(manager.readPidFile('work')).toBe(33333)
  })
})

describe('GatewayManager gateway process env', () => {
  it('keeps full inherited env for the default profile for compatibility', async () => {
    const home = createHermesHome()
    process.env.WEIXIN_TOKEN = 'from-parent'
    process.env.CUSTOM_GATEWAY_SETTING = 'keep-me'
    process.env.HERMES_HOME = home
    vi.resetModules()
    const { buildGatewayProcessEnv } = await import('../../packages/server/src/services/hermes/gateway-manager')

    const env = buildGatewayProcessEnv('default', home)

    expect(env.WEIXIN_TOKEN).toBe('from-parent')
    expect(env.CUSTOM_GATEWAY_SETTING).toBe('keep-me')
    expect(env.HERMES_HOME).toBe(home)
  })

  it('removes parent env keys defined by any profile env for non-default profile gateways', async () => {
    const home = createHermesHome()
    const workHome = join(home, 'profiles', 'work')
    mkdirSync(workHome, { recursive: true })
    writeFileSync(join(home, '.env'), [
      'WEIXIN_TOKEN=default-weixin',
      'WECOM_SECRET=default-wecom',
      'FUTURE_PLATFORM_TOKEN=default-future',
      'export EXPORTED_SECRET=default-export',
      'PATH=/default/path',
      'HTTP_PROXY=http://default-proxy.local:8080',
      'COMMENTED_OUT_SECRET=not-commented',
      '# COMMENTED_OUT_SECRET=commented',
    ].join('\n'))
    writeFileSync(join(workHome, '.env'), [
      'WORK_ONLY_TOKEN=work-profile',
      'PARENT_OVERRIDE_ME=work-profile',
    ].join('\n'))

    process.env.PATH = '/opt/hermes/.venv/bin:/usr/bin'
    process.env.HOME = '/home/agent'
    process.env.HTTP_PROXY = 'http://proxy.local:8080'
    process.env.HERMES_BIN = '/opt/hermes/.venv/bin/hermes'
    process.env.HERMES_ALLOW_ROOT_GATEWAY = '1'
    process.env.HERMES_HOME = home
    process.env.WEIXIN_TOKEN = 'from-parent'
    process.env.WECOM_SECRET = 'from-parent'
    process.env.FUTURE_PLATFORM_TOKEN = 'from-parent'
    process.env.EXPORTED_SECRET = 'from-parent'
    process.env.WORK_ONLY_TOKEN = 'from-parent'
    process.env.PARENT_OVERRIDE_ME = 'from-parent'
    process.env.UNKNOWN_SERVICE_TOKEN = 'keep-me'
    process.env.COMMENTED_OUT_SECRET = 'from-parent'
    process.env.CUSTOM_GATEWAY_SETTING = 'from-parent'
    vi.resetModules()
    const { buildGatewayProcessEnv } = await import('../../packages/server/src/services/hermes/gateway-manager')

    const env = buildGatewayProcessEnv('work', join(home, 'profiles', 'work'))

    expect(env.HERMES_HOME).toBe(join(home, 'profiles', 'work'))
    expect(env.PATH).toBe('/opt/hermes/.venv/bin:/usr/bin')
    expect(env.HOME).toBe('/home/agent')
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.HERMES_BIN).toBe('/opt/hermes/.venv/bin/hermes')
    expect(env.HERMES_ALLOW_ROOT_GATEWAY).toBe('1')
    expect(env.WEIXIN_TOKEN).toBeUndefined()
    expect(env.WECOM_SECRET).toBeUndefined()
    expect(env.FUTURE_PLATFORM_TOKEN).toBeUndefined()
    expect(env.EXPORTED_SECRET).toBeUndefined()
    expect(env.WORK_ONLY_TOKEN).toBeUndefined()
    expect(env.PARENT_OVERRIDE_ME).toBeUndefined()
    expect(env.COMMENTED_OUT_SECRET).toBeUndefined()
    expect(env.UNKNOWN_SERVICE_TOKEN).toBe('keep-me')
    expect(env.CUSTOM_GATEWAY_SETTING).toBe('from-parent')
  })
})

describe('GatewayManager gateway port allocation', () => {
  it('skips the Web UI listen port when assigning gateway ports', async () => {
    const home = createHermesHome()
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    process.env.HERMES_HOME = home
    process.env.PORT = '8648'
    vi.resetModules()
    const { GatewayManager } = await import('../../packages/server/src/services/hermes/gateway-manager')
    const manager = new GatewayManager('default') as any
    manager.allocatedPorts = new Set([8642, 8643, 8644, 8645, 8646, 8647])

    const endpoint = await manager.resolvePort('work')

    expect(endpoint.port).toBe(8649)
  })
})
