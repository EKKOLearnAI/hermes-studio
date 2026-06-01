import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, dirname, join } from 'path'

type UpdateControllerMocks = {
  execFile: ReturnType<typeof vi.fn>
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
  readFileSync: ReturnType<typeof vi.fn>
  appendFileSync: ReturnType<typeof vi.fn>
}

async function loadUpdateController(overrides: Partial<UpdateControllerMocks> = {}) {
  const execFile = overrides.execFile ?? vi.fn((_command: string, _args: string[], _options: any, callback: any) => callback(null, '', ''))
  const execFileSync = overrides.execFileSync ?? vi.fn().mockReturnValue('updated')
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref, on: vi.fn() }))
  const existsSync = overrides.existsSync ?? vi.fn(() => true)
  const readFileSync = overrides.readFileSync ?? vi.fn(() => JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.0.0',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
  }))
  const appendFileSync = overrides.appendFileSync ?? vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFile, execFileSync, spawn }))
  vi.doMock('fs', () => ({
    appendFileSync,
    closeSync: vi.fn(),
    existsSync,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    readFileSync,
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  }))

  const mod = await import('../../packages/server/src/controllers/update')
  return {
    ...mod,
    mocks: { execFile, execFileSync, spawn, unref, existsSync, readFileSync, appendFileSync },
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
    vi.unstubAllGlobals()
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
    delete process.env.HERMES_WEB_UI_PREVIEW_REPO
  })

  it('updates and restarts through the running Node executable, not PATH shims', async () => {
    process.env.PORT = '9129'
    const nodeBinDir = getNodeBinDir()
    const npmCli = getNpmCliPath()
    const globalPrefix = getNodePrefix()
    const cliScript = getGlobalCliScript(globalPrefix)
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args[1] === 'root') {
        return process.platform === 'win32'
          ? join(globalPrefix, 'node_modules')
          : join(globalPrefix, 'lib', 'node_modules')
      }
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
        windowsHide: true,
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
      [npmCli, 'root', '-g'],
      expect.objectContaining({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
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

  it('does not log a restart error when the restart helper exits successfully', async () => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unref = vi.fn()
    const restart = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return restart
      }),
    }
    const spawn = vi.fn(() => restart)
    const { handleUpdate } = await loadUpdateController({ spawn, unref })
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    vi.runAllTimers()
    handlers.get('exit')?.(0, null)

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
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

  it('loads preview tags through async git with a short timeout', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-web-ui'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, [
        'abc123\trefs/tags/v0.6.6',
        'def456\trefs/tags/v0.6.7',
      ].join('\n'), '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const { previewTags, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.7', sha: 'def456' },
        { name: 'v0.6.6', sha: 'abc123' },
      ],
    })
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--tags', '--refs', 'https://github.com/EKKOLearnAI/hermes-web-ui.git'],
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    )
  })

  it('falls back to GitHub API when async git tag loading fails', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-web-ui'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(new Error('git timeout'), '', '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { name: 'v0.6.7', commit: { sha: 'def456' } },
        { name: 'v0.6.6', commit: { sha: 'abc123' } },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { previewTags } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.7', sha: 'def456' },
        { name: 'v0.6.6', sha: 'abc123' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/EKKOLearnAI/hermes-web-ui/tags?per_page=100',
      expect.objectContaining({
        headers: { 'User-Agent': 'hermes-web-ui-preview' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('runs preview npm install through async execFile', async () => {
    const npmCli = getNpmCliPath()
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, 'installed', '')
    })
    const execFileSync = vi.fn(() => '')
    const { installPreview, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await installPreview(ctx)

    expect(ctx.status).toBe(202)
    expect((ctx.body as any).success).toBe(true)
    expect((ctx.body as any).accepted).toBe(true)
    expect((ctx.body as any).active_action).toBe('install')
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.objectContaining({
        timeout: 15 * 60 * 1000,
        cwd: expect.any(String),
      }),
      expect.any(Function),
    )
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.any(Object),
    )
  })

})
