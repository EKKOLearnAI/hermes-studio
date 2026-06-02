import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  gatewayStatusLooksRuntimeLocked,
  gatewayStatusLooksRunning,
  gatewayStateLooksRunningForProfile,
  parseGatewayStatusesFromProfileListOutput,
  shouldUseManagedGatewayRun,
  shouldUseManagedGatewayRunForAutostart,
} from '../../packages/server/src/services/hermes/gateway-autostart'

describe('gateway autostart status parsing', () => {
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
