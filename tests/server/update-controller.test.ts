import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, dirname, join } from 'path'

type UpdateControllerMocks = {
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
}

async function loadUpdateController(overrides: Partial<UpdateControllerMocks> = {}) {
  const execFileSync = overrides.execFileSync ?? vi.fn().mockReturnValue('updated')
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref }))
  const existsSync = overrides.existsSync ?? vi.fn(() => true)

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFileSync, spawn }))
  vi.doMock('fs', () => ({ existsSync }))

  const mod = await import('../../packages/server/src/controllers/update')
  return {
    ...mod,
    mocks: { execFileSync, spawn, unref, existsSync },
  }
}

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
  }
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getNpmCliPath() {
  const prefix = getNodePrefix()
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function getGlobalCliScript(prefix: string) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', 'hermes-web-ui', 'bin', 'hermes-web-ui.mjs')
    : join(prefix, 'lib', 'node_modules', 'hermes-web-ui', 'bin', 'hermes-web-ui.mjs')
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
    vi.doUnmock('child_process')
    vi.doUnmock('fs')
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
  })

  it('updates and restarts through the running Node executable, not PATH shims', async () => {
    process.env.PORT = '9129'
    const nodeBinDir = getNodeBinDir()
    const npmCli = getNpmCliPath()
    const globalPrefix = getNodePrefix()
    const cliScript = getGlobalCliScript(globalPrefix)
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args[1] === 'prefix') return globalPrefix
      return 'updated'
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '-g', 'hermes-web-ui@latest'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({
          npm_node_execpath: process.execPath,
          PATH: expect.stringContaining(`${nodeBinDir}${delimiter}`),
        }),
      }),
    )
    expect(ctx.body).toEqual({ success: true, message: 'updated' })

    vi.runAllTimers()

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'prefix', '-g'],
      expect.objectContaining({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [cliScript, 'restart', '--port', '9129'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
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
      process.execPath,
      [expect.any(String), 'restart', '--port', '8648'],
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

  it('fails closed instead of falling back to PATH npm when the current Node install has no npm CLI', async () => {
    const { handleUpdate, mocks } = await loadUpdateController({ existsSync: vi.fn(() => false) })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      message: expect.stringContaining(`Unable to locate npm CLI for ${process.execPath}`),
    })
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
