import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
const existsSync = vi.hoisted(() => vi.fn(() => true))
const utimesSync = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn }))
vi.mock('fs', () => ({ existsSync, utimesSync }))

import {
  resetWebUiRestartForTests,
  scheduleWebUiRestart,
} from '../../packages/server/src/modules/studio/public/web-ui-restart'

describe('Web UI restart routing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('HERMES_DESKTOP', '')
    vi.stubEnv('NODE_ENV', 'test')
    spawn.mockReset()
    existsSync.mockReset()
    existsSync.mockReturnValue(true)
    utimesSync.mockReset()
    resetWebUiRestartForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('touches the nodemon restart trigger in development', () => {
    vi.stubEnv('NODE_ENV', 'development')

    scheduleWebUiRestart()
    vi.advanceTimersByTime(250)

    expect(utimesSync).toHaveBeenCalledWith(
      expect.stringContaining('packages/server/src/modules/studio/public/dev-restart-trigger.ts'),
      expect.any(Date),
      expect.any(Date),
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps Desktop restart ownership in the Electron shell', () => {
    vi.stubEnv('HERMES_DESKTOP', 'true')

    expect(() => scheduleWebUiRestart()).toThrow('Desktop Runtime must restart through the desktop shell')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses the standalone CLI supervisor outside development', () => {
    const unref = vi.fn()
    spawn.mockReturnValue({ unref })
    vi.stubEnv('NODE_ENV', 'production')

    scheduleWebUiRestart()
    vi.advanceTimersByTime(250)

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['restart', '--port', '--no-open']),
      expect.objectContaining({ detached: true }),
    )
    expect(unref).toHaveBeenCalled()
  })
})
