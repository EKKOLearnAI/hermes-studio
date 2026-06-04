import { afterEach, describe, expect, it } from 'vitest'
import { getShutdownForceExitMs, shouldStopAgentBridgeOnShutdown } from '../../packages/server/src/services/shutdown'

describe('shutdown bridge policy', () => {
  const originalValue = process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN
  const originalDesktop = process.env.HERMES_DESKTOP
  const originalForceExitMs = process.env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS

  afterEach(() => {
    if (originalValue === undefined) delete process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN
    else process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = originalValue
    if (originalDesktop === undefined) delete process.env.HERMES_DESKTOP
    else process.env.HERMES_DESKTOP = originalDesktop
    if (originalForceExitMs === undefined) delete process.env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS
    else process.env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS = originalForceExitMs
  })

  it('keeps the bridge for restart signals and stops it for service shutdown signals by default', () => {
    delete process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN

    expect(shouldStopAgentBridgeOnShutdown('SIGUSR2')).toBe(false)
    expect(shouldStopAgentBridgeOnShutdown('SIGTERM')).toBe(true)
    expect(shouldStopAgentBridgeOnShutdown('SIGINT')).toBe(true)
  })

  it('allows operators to force either bridge shutdown policy', () => {
    process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = '1'
    expect(shouldStopAgentBridgeOnShutdown('SIGUSR2')).toBe(true)

    process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = '0'
    expect(shouldStopAgentBridgeOnShutdown('SIGTERM')).toBe(false)
  })

  it('keeps desktop shutdown force-exit timing short by default', () => {
    delete process.env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS

    delete process.env.HERMES_DESKTOP
    expect(getShutdownForceExitMs()).toBe(15_000)

    process.env.HERMES_DESKTOP = 'true'
    expect(getShutdownForceExitMs()).toBe(3_000)
  })

  it('allows operators to override shutdown force-exit timing', () => {
    process.env.HERMES_DESKTOP = 'true'
    process.env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS = '7000'

    expect(getShutdownForceExitMs()).toBe(7_000)
  })
})
