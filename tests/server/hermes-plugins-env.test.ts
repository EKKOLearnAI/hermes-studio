import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Hermes plugin discovery environment', () => {
  const originalEnv = { ...process.env }
  const pluginResult = JSON.stringify({
    plugins: [],
    warnings: [],
    metadata: {
      hermesAgentRoot: '',
      pythonExecutable: '',
      cwd: '',
      projectPluginsEnabled: false,
    },
  })
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-plugins-env-'))
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('uses the Python and agent root resolved by the bridge command', async () => {
    const agentRoot = join(tempDir, 'agent')
    const fakePython = join(tempDir, 'python')
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, { stdout: pluginResult, stderr: '' })
    })
    vi.doMock('child_process', () => ({ execFile }))
    vi.doMock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
      resolveAgentBridgeCommand: () => ({
        command: fakePython,
        argsPrefix: [],
        agentRoot,
        hermesHome: join(tempDir, 'home'),
      }),
    }))

    process.env.HERMES_HOME = join(tempDir, 'home')

    const { listHermesPlugins } = await import('../../packages/server/src/services/hermes/plugins')
    await expect(listHermesPlugins()).resolves.toMatchObject({ plugins: [] })

    expect(execFile).toHaveBeenCalledOnce()
    const [command, args, options] = execFile.mock.calls[0]
    expect(command).toBe(fakePython)
    expect(args.slice(0, 2)).toEqual(['-I', '-c'])
    expect(options.env.HERMES_AGENT_ROOT_RESOLVED).toBe(agentRoot)
  })

  it('uses package Python without isolated mode when no source root is resolved', async () => {
    const fakePython = join(tempDir, 'python')
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, { stdout: pluginResult, stderr: '' })
    })
    vi.doMock('child_process', () => ({ execFile }))
    vi.doMock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
      resolveAgentBridgeCommand: () => ({
        command: fakePython,
        argsPrefix: [],
        agentRoot: undefined,
        hermesHome: join(tempDir, 'home'),
      }),
    }))

    process.env.HERMES_HOME = join(tempDir, 'home')
    process.env.PYTHONPATH = join(tempDir, 'shadow-path')
    process.env.PYTHONHOME = join(tempDir, 'shadow-home')

    const { listHermesPlugins } = await import('../../packages/server/src/services/hermes/plugins')
    await expect(listHermesPlugins()).resolves.toMatchObject({ plugins: [] })

    expect(execFile).toHaveBeenCalledOnce()
    const [command, args, options] = execFile.mock.calls[0]
    expect(command).toBe(fakePython)
    expect(args[0]).toBe('-c')
    expect(options.env.PYTHONPATH).toBeUndefined()
    expect(options.env.PYTHONHOME).toBeUndefined()
  })
})
