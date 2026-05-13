import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME
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
