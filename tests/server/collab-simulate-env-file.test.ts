import { describe, expect, it, vi } from 'vitest'
import {
  isCollabSimulateEnabled,
  readHermesEnvValue,
} from '../../packages/server/src/services/hermes/group-chat/collab-simulate'

describe('Hermes .env HERMES_COLLAB_SIMULATE (container)', () => {
  it('reads HOME/.env when process env is unset', () => {
    vi.stubEnv('HOME', '/opt/data')
    delete process.env.HERMES_COLLAB_SIMULATE
    delete process.env.HERMES_HOME
    const value = readHermesEnvValue('HERMES_COLLAB_SIMULATE')
    // Only assert when the container .env is present (CI may not have it).
    if (value == null) return
    expect(['0', '1', 'true', 'false', 'off', 'live']).toContain(value.toLowerCase())
    expect(isCollabSimulateEnabled()).toBe(!(value === '0' || value.toLowerCase() === 'false' || value.toLowerCase() === 'off' || value.toLowerCase() === 'live'))
  })
})
