import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'path'

type ChildProcessMocks = {
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

async function loadUpdateController(overrides: Partial<ChildProcessMocks> = {}) {
  const execFileSync = overrides.execFileSync ?? vi.fn().mockReturnValue('updated')
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref }))

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFileSync, spawn }))

  const mod = await import('../../packages/server/src/controllers/update')
  return {
    ...mod,
    mocks: { execFileSync, spawn, unref },
  }
}

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
  }
}

describe('update controller', () => {
  const originalPort = process.env.PORT
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
  })

  it('updates using npm from the active node prefix and restarts via the same cli path', async () => {
    process.env.PORT = '9129'
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()
    const nodeBinDir = dirname(process.execPath)

    await handleUpdate(ctx)

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      join(nodeBinDir, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
      ['install', '-g', 'hermes-web-ui@latest'],
      {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    expect(ctx.body).toEqual({ success: true, message: 'updated' })

    vi.runAllTimers()

    expect(mocks.spawn).toHaveBeenCalledWith(
      join(nodeBinDir, process.platform === 'win32' ? 'hermes-web-ui.cmd' : 'hermes-web-ui'),
      ['restart', '--port', '9129'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    expect(mocks.unref).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('falls back to the default port when PORT is not set', async () => {
    delete process.env.PORT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    vi.runAllTimers()

    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['restart', '--port', '8648'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    )
  })

  it('returns a 500 with stderr when installation fails', async () => {
    const execFileSync = vi.fn(() => {
      const error = new Error('install failed') as Error & { stderr?: string }
      error.stderr = 'engine mismatch'
      throw error
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ success: false, message: 'engine mismatch' })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
