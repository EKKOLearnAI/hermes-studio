import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  gatewayStatusLooksRuntimeLocked,
  gatewayStatusLooksRunning,
  gatewayStateLooksRunningForProfile,
  parseGatewayStatusesFromProfileListOutput,
  recoverWindowsDesktopGatewayOrphans,
  selectProfilesForGatewayAutostart,
  shouldRecoverWindowsDesktopGatewayOrphans,
  shouldUseManagedGatewayRun,
  shouldUseManagedGatewayRunForAutostart,
} from '../../packages/server/src/services/hermes/gateway-autostart'

describe('gateway autostart status parsing', () => {
  it('selects all profiles by default for gateway autostart', () => {
    expect(selectProfilesForGatewayAutostart(['default', 'work', 'test'])).toEqual(['default', 'work', 'test'])
  })

  it('honors gateway autostart include, exclude, disabled, and unknown profiles', () => {
    const profiles = ['default', 'work', 'reviewer', 'scratch']

    expect(selectProfilesForGatewayAutostart(profiles, { include: ['work', 'missing', 'work', ' reviewer '] })).toEqual([
      'work',
      'reviewer',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { exclude: ['scratch', 'missing'] })).toEqual([
      'default',
      'work',
      'reviewer',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { include: ['work', 'scratch'], exclude: ['scratch'] })).toEqual([
      'work',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { include: ['missing'] })).toEqual([])
    expect(selectProfilesForGatewayAutostart(profiles, { include: [] })).toEqual([])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: false, include: ['default'] })).toEqual([])
  })

  it('treats runtime lock conflicts as an already-running gateway', () => {
    expect(gatewayStatusLooksRuntimeLocked(
      'Gateway runtime lock is already held by another instance. Exiting.',
    )).toBe(true)
  })

  it('does not treat not-running status as running', () => {
    expect(gatewayStatusLooksRunning('Gateway is not running')).toBe(false)
  })

  it('parses gateway status from hermes profile list output', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆default         glm-5-turbo                  running      —            —
  akri            glm-5-turbo                  running      akri         —
  tester          gpt-5.5                      stopped      tester       —
`
    const statuses = parseGatewayStatusesFromProfileListOutput(output, ['default', 'akri', 'tester'])
    expect(statuses.get('default')).toBe('running')
    expect(statuses.get('akri')).toBe('running')
    expect(statuses.get('tester')).toBe('stopped')
  })

  it('parses gateway status when profile or model fills the table column', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  daily_assistant deepseek-v4-flash            running      —            —
  long_model      provider/model-name-that-fills-column stopped      —            —
`
    const statuses = parseGatewayStatusesFromProfileListOutput(output, ['daily_assistant', 'long_model'])
    expect(statuses.get('daily_assistant')).toBe('running')
    expect(statuses.get('long_model')).toBe('stopped')
  })

  it('uses profile-list gateway status text for running checks', () => {
    expect(gatewayStatusLooksRunning('running')).toBe(true)
    expect(gatewayStatusLooksRunning('stopped')).toBe(false)
    expect(gatewayStatusLooksRunning('not running')).toBe(false)
  })

  it('allows managed gateway mode to be forced by environment', () => {
    const previous = process.env.HERMES_WEB_UI_MANAGED_GATEWAY
    process.env.HERMES_WEB_UI_MANAGED_GATEWAY = '1'
    try {
      expect(shouldUseManagedGatewayRun()).toBe(true)
      expect(shouldUseManagedGatewayRunForAutostart()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.HERMES_WEB_UI_MANAGED_GATEWAY
      else process.env.HERMES_WEB_UI_MANAGED_GATEWAY = previous
    }
  })

  it('uses managed gateway autostart on Windows', () => {
    expect(shouldUseManagedGatewayRunForAutostart('win32')).toBe(true)
  })

  it('only recovers Windows desktop gateway orphans when enabled', () => {
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', { HERMES_DESKTOP: 'true' })).toBe(true)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('darwin', { HERMES_DESKTOP: 'true' })).toBe(false)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', {})).toBe(false)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', {
      HERMES_DESKTOP: 'true',
      HERMES_WEB_UI_DISABLE_GATEWAY_STARTUP_RECOVERY: '1',
    })).toBe(false)
  })

  it('kills Windows desktop gateway runtime PIDs and removes stale runtime files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-recovery-'))
    const workHome = join(home, 'profiles', 'work')
    mkdirSync(workHome, { recursive: true })
    const killed: number[] = []
    const stopped: string[] = []

    try {
      writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: 11111 }), 'utf-8')
      writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 99999, gateway_state: 'stopped' }), 'utf-8')
      writeFileSync(join(workHome, 'gateway.lock'), JSON.stringify({ pid: '22222' }), 'utf-8')
      writeFileSync(join(workHome, 'gateway_state.json'), JSON.stringify({ pid: 33333, gateway_state: 'running' }), 'utf-8')

      const result = await recoverWindowsDesktopGatewayOrphans({
        platform: 'win32',
        env: { HERMES_DESKTOP: 'true' },
        hermesHome: home,
        isAlive: pid => pid !== 99999,
        stopGateway: async profileDir => { stopped.push(profileDir) },
        execTaskkill: async pid => { killed.push(pid) },
      })

      expect(result.attempted).toBe(true)
      expect(stopped.sort()).toEqual([home, workHome].sort())
      expect(result.stoppedProfileDirs.sort()).toEqual([home, workHome].sort())
      expect(killed.sort((a, b) => a - b)).toEqual([11111, 22222, 33333])
      expect(result.killedPids.sort((a, b) => a - b)).toEqual([11111, 22222, 33333])
      expect(existsSync(join(home, 'gateway.pid'))).toBe(false)
      expect(existsSync(join(home, 'gateway_state.json'))).toBe(false)
      expect(existsSync(join(workHome, 'gateway.lock'))).toBe(false)
      expect(existsSync(join(workHome, 'gateway_state.json'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('skips recovery outside Windows desktop mode without deleting runtime files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-recovery-skip-'))
    try {
      const pidPath = join(home, 'gateway.pid')
      writeFileSync(pidPath, JSON.stringify({ pid: 11111 }), 'utf-8')

      const result = await recoverWindowsDesktopGatewayOrphans({
        platform: 'linux',
        env: { HERMES_DESKTOP: 'true' },
        hermesHome: home,
        isAlive: () => {
          throw new Error('should not check liveness')
        },
      })

      expect(result.attempted).toBe(false)
      expect(existsSync(pidPath)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('detects managed gateway state files with a live pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-state-'))
    try {
      writeFileSync(
        join(dir, 'gateway_state.json'),
        JSON.stringify({ pid: process.pid, gateway_state: 'running' }),
        'utf-8',
      )
      expect(gatewayStateLooksRunningForProfile(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
