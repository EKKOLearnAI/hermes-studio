import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ appHome: '' }))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    get appHome() {
      return state.appHome
    },
  },
}))

const temporaryDirectories: string[] = []

function platformKey(): string {
  const osLabel = process.platform === 'darwin' ? 'mac' : process.platform
  return `${osLabel}-${process.arch}`
}

function cli(path: string, version: string): string {
  mkdirSync(path, { recursive: true })
  const command = join(path, 'hermes')
  writeFileSync(command, `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`)
  chmodSync(command, 0o755)
  return command
}

function failingCli(path: string): string {
  mkdirSync(path, { recursive: true })
  const command = join(path, 'hermes')
  writeFileSync(command, '#!/bin/sh\nexit 1\n')
  chmodSync(command, 0o755)
  return command
}

function createUserCli(home: string, version: string): {
  command: string
  python: string
  agentRoot: string
  hermesHome: string
} {
  const hermesHome = join(home, '.hermes')
  const agentRoot = join(hermesHome, 'hermes-agent')
  const python = join(agentRoot, 'venv', 'bin', 'python3')
  const agentCommand = join(agentRoot, 'hermes')
  const command = join(home, '.local', 'bin', 'hermes')
  mkdirSync(join(agentRoot, 'venv', 'bin'), { recursive: true })
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  writeFileSync(join(agentRoot, 'cli.py'), '')
  writeFileSync(agentCommand, '')
  writeFileSync(python, `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`)
  writeFileSync(command, `#!/bin/sh\nexec "${python}" "${agentCommand}" "$@"\n`)
  chmodSync(python, 0o755)
  chmodSync(command, 0o755)
  return { command, python, agentRoot, hermesHome }
}

function createManagedRuntime(
  root: string,
  version: string,
  options: { activate?: boolean; command?: string } = {},
): string {
  const runtime = join(root, 'desktop-runtime', 'hermes', version, platformKey())
  const environmentBin = join(runtime, 'python', 'venv', 'bin')
  const managedCli = cli(environmentBin, version)
  if (options.command) {
    writeFileSync(managedCli, options.command)
    chmodSync(managedCli, 0o755)
  }
  writeFileSync(join(environmentBin, 'python3'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(environmentBin, 'python3'), 0o755)
  writeFileSync(join(runtime, 'python', 'run_agent.py'), '')
  writeFileSync(join(runtime, 'python', 'cli.py'), '')
  mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'node', 'bin', 'node'), '')
  writeFileSync(join(runtime, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: platformKey(),
    hermesAgentVersion: version,
  }))
  if (options.activate !== false) {
    writeFileSync(join(root, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: version,
      runtimeDirectory: runtime,
      platform: platformKey(),
    }))
  }
  return managedCli
}

afterEach(() => {
  vi.resetModules()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Hermes Runtime selection', () => {
  it('prefers a user Hermes CLI over an active managed Runtime', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const managedCli = createManagedRuntime(state.appHome, '0.21.0')
    const userHome = join(state.appHome, 'user-home')
    const userCli = createUserCli(userHome, '0.20.4')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_DESKTOP: undefined,
      HERMES_RUNTIME_SELECTION_LOCKED: undefined,
      HOME: userHome,
      HERMES_HOME: userCli.hermesHome,
      HERMES_BIN: managedCli,
      HERMES_AGENT_BRIDGE_PYTHON: '/old/runtime/python',
      HERMES_AGENT_CLI_PYTHON: '/old/runtime/python',
      HERMES_AGENT_ROOT: '/old/runtime/root',
      PATH: [join(managedCli, '..'), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)

    expect(selected).toMatchObject({
      source: 'user-cli',
      path: userCli.command,
      version: '0.20.4',
      pythonPath: userCli.python,
      agentRoot: userCli.agentRoot,
    })
    expect(env.HERMES_BIN).toBe(userCli.command)
    expect(env.HERMES_AGENT_BRIDGE_PYTHON).toBe(userCli.python)
    expect(env.HERMES_AGENT_CLI_PYTHON).toBe(userCli.python)
    expect(env.HERMES_AGENT_ROOT).toBe(userCli.agentRoot)
    expect(env.VIRTUAL_ENV).toBe(join(userCli.agentRoot, 'venv'))
    expect(env.PATH?.split(delimiter)[0]).toBe(join(userHome, '.local', 'bin'))
  })

  it('uses the active managed Runtime when no user CLI exists', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const managedCli = createManagedRuntime(state.appHome, '0.21.0')
    const userHome = join(state.appHome, 'empty-home')
    mkdirSync(userHome)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_DESKTOP: undefined,
      HERMES_RUNTIME_SELECTION_LOCKED: undefined,
      HOME: userHome,
      HERMES_HOME: join(userHome, '.hermes'),
      HERMES_BIN: managedCli,
      PATH: [join(managedCli, '..'), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)

    expect(selected).toMatchObject({ source: 'managed-runtime', path: managedCli, version: '0.21.0' })
    expect(env.HERMES_AGENT_BRIDGE_PYTHON).toBe(join(state.appHome, 'desktop-runtime', 'hermes', '0.21.0', platformKey(), 'python', 'venv', 'bin', 'python3'))
  })

  it('falls back to the active managed Runtime when a user CLI cannot report its version', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const managedCli = createManagedRuntime(state.appHome, '0.21.0')
    const userCli = failingCli(join(state.appHome, 'user-bin'))
    const userHome = join(state.appHome, 'empty-home')
    mkdirSync(userHome)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_DESKTOP: undefined,
      HERMES_RUNTIME_SELECTION_LOCKED: undefined,
      HOME: userHome,
      HERMES_HOME: join(userHome, '.hermes'),
      HERMES_BIN: managedCli,
      HERMES_AGENT_BRIDGE_PYTHON: '/old/runtime/python',
      HERMES_AGENT_CLI_PYTHON: '/old/runtime/python',
      VIRTUAL_ENV: '/old/runtime',
      PATH: [join(managedCli, '..'), join(userCli, '..'), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)
    const runtimeEnvironment = join(state.appHome, 'desktop-runtime', 'hermes', '0.21.0', platformKey(), 'python', 'venv')

    expect(selected).toMatchObject({ source: 'managed-runtime', path: managedCli, version: '0.21.0' })
    expect(env.HERMES_BIN).toBe(managedCli)
    expect(env.HERMES_AGENT_BRIDGE_PYTHON).toBe(join(runtimeEnvironment, 'bin', 'python3'))
    expect(env.HERMES_AGENT_CLI_PYTHON).toBe(join(runtimeEnvironment, 'bin', 'python3'))
    expect(env.VIRTUAL_ENV).toBe(runtimeEnvironment)
  })

  it('trusts a Desktop-locked selection without probing PATH again', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const env: NodeJS.ProcessEnv = {
      HERMES_DESKTOP: 'true',
      HERMES_RUNTIME_SELECTION_LOCKED: 'true',
      HERMES_RUNTIME_SOURCE: 'user-cli',
      HERMES_RUNTIME_VERSION: '0.20.5',
      HERMES_BIN: join(state.appHome, 'does-not-need-to-exist', 'hermes'),
      HERMES_AGENT_CLI_PYTHON: join(state.appHome, 'does-not-need-to-exist', 'python3'),
      HERMES_AGENT_ROOT: join(state.appHome, 'does-not-need-to-exist', 'agent'),
      PATH: join(state.appHome, 'empty-path'),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)

    expect(selected).toEqual({
      source: 'user-cli',
      path: env.HERMES_BIN,
      version: '0.20.5',
      pythonPath: env.HERMES_AGENT_CLI_PYTHON,
      agentRoot: env.HERMES_AGENT_ROOT,
    })
  })

  it('falls back one Runtime at a time, isolates its environment, and preserves Web UI activation', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const attempts = join(state.appHome, 'attempts.log')
    const fallbackCli = createManagedRuntime(state.appHome, '0.20.6', {
      activate: false,
      command: `#!/bin/sh\nprintf 'fallback\\n' >> "${attempts}"\ncase "$PATH" in *0.21.0*) exit 41;; esac\nprintf 'Hermes Agent 0.20.6\\n'\n`,
    })
    const failingCli = createManagedRuntime(state.appHome, '0.21.0', {
      command: `#!/bin/sh\nprintf 'failing\\n' >> "${attempts}"\nexit 23\n`,
    })
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf8'))
    writeFileSync(activeVersionPath, JSON.stringify({
      ...active,
      webUiVersion: '0.7.12',
      webUiDirectory: '/preserved/webui',
    }))
    const invalidRuntime = join(state.appHome, 'desktop-runtime', 'hermes', '0.21.0', platformKey())
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(state.appHome, 'empty-home'),
      HERMES_HOME: join(state.appHome, 'empty-home', '.hermes'),
      HERMES_DESKTOP: undefined,
      HERMES_RUNTIME_SELECTION_LOCKED: undefined,
      HERMES_BIN: failingCli,
      AGENT_BROWSER_HOME: join(invalidRuntime, 'python', 'agent-browser'),
      PATH: [dirname(failingCli), '/usr/bin', '/bin'].join(delimiter),
    }
    mkdirSync(env.HOME!)

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)
    const persisted = JSON.parse(readFileSync(activeVersionPath, 'utf8'))

    expect(selected).toMatchObject({ source: 'managed-runtime', path: fallbackCli, version: '0.20.6' })
    expect(readFileSync(attempts, 'utf8').trim().split('\n')).toEqual(['failing', 'fallback'])
    expect(env.PATH).not.toContain('0.21.0')
    expect(env.AGENT_BROWSER_HOME).toContain('0.20.6')
    expect(persisted).toMatchObject({
      runtimeDirectory: join(state.appHome, 'desktop-runtime', 'hermes', '0.20.6', platformKey()),
      hermesRuntimeVersion: '0.20.6',
      webUiVersion: '0.7.12',
      webUiDirectory: '/preserved/webui',
      runtimeActivationError: expect.stringContaining('(23)'),
      runtimeValidationFailures: [expect.objectContaining({
        version: '0.21.0',
        directory: invalidRuntime,
        reason: expect.stringContaining('(23)'),
      })],
    })
  })

  it('marks every failed Runtime unavailable so the version can be downloaded again', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const failingCli = createManagedRuntime(state.appHome, '0.20.0', {
      command: '#!/bin/sh\nexit 23\n',
    })
    const runtimeDirectory = join(state.appHome, 'desktop-runtime', 'hermes', '0.20.0', platformKey())
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf8'))
    writeFileSync(activeVersionPath, JSON.stringify({ ...active, webUiVersion: '0.7.12' }))
    const home = join(state.appHome, 'empty-home')
    mkdirSync(home)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      HERMES_HOME: join(home, '.hermes'),
      HERMES_DESKTOP: undefined,
      HERMES_RUNTIME_SELECTION_LOCKED: undefined,
      HERMES_BIN: failingCli,
      PATH: [dirname(failingCli), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)
    const versionManager = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const persisted = JSON.parse(readFileSync(activeVersionPath, 'utf8'))

    expect(selected).toEqual({ source: 'none', path: '', version: '' })
    expect(versionManager.listInstalledRuntimeVersions()).toEqual([])
    expect(persisted.runtimeDirectory).toBeUndefined()
    expect(persisted.hermesRuntimeVersion).toBeUndefined()
    expect(persisted.webUiVersion).toBe('0.7.12')
    expect(persisted.runtimeValidationFailures).toEqual([
      expect.objectContaining({
        version: '0.20.0',
        directory: runtimeDirectory,
        reason: expect.stringContaining('(23)'),
      }),
    ])
  })
})
