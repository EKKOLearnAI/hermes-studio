import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveDesktopHermesSelection,
  withDesktopHermesSelection,
  type DesktopManagedHermesRuntime,
} from '../../packages/desktop/src/main/hermes-environment-selection'

const temporaryDirectories: string[] = []

function executable(path: string, source: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source)
  chmodSync(path, 0o755)
  return path
}

function userCli(root: string, version: string, succeeds = true) {
  const hermesHome = join(root, '.hermes')
  const agentRoot = join(hermesHome, 'hermes-agent')
  const environmentRoot = join(agentRoot, 'venv')
  const python = executable(
    join(environmentRoot, 'bin', 'python3'),
    succeeds
      ? `#!/bin/sh\nprintf '${version}\\n'\n`
      : '#!/bin/sh\nexit 1\n',
  )
  const agentCommand = join(agentRoot, 'hermes')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  writeFileSync(join(agentRoot, 'cli.py'), '')
  writeFileSync(agentCommand, '')
  const command = executable(
    join(root, '.local', 'bin', 'hermes'),
    `#!/bin/sh\nexec "${python}" "${agentCommand}" "$@"\n`,
  )
  return { command, python, agentRoot, environmentRoot, hermesHome }
}

function managedRuntime(
  root: string,
  version: string,
  options: { name?: string; command?: string; pythonCommand?: string; probePath?: string } = {},
): DesktopManagedHermesRuntime {
  const directory = join(root, options.name || 'managed-runtime')
  const agentRoot = join(directory, 'python')
  const environmentRoot = join(agentRoot, 'venv')
  const pythonPath = executable(
    join(environmentRoot, 'bin', 'python3'),
    options.pythonCommand || `#!/bin/sh\nprintf '${version}\\n'\n`,
  )
  const path = executable(
    join(environmentRoot, 'bin', 'hermes'),
    options.command || `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`,
  )
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  writeFileSync(join(agentRoot, 'cli.py'), '')
  return {
    directory,
    path,
    pythonPath,
    agentRoot,
    environmentRoot,
    managedRuntimeVersion: version,
    ...(options.probePath ? { probePath: options.probePath } : {}),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('desktop Hermes environment selection', () => {
  it('validates the user CLI before injecting one complete environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-hermes-selection-'))
    temporaryDirectories.push(root)
    const user = userCli(join(root, 'user'), '0.20.5')
    const managed = managedRuntime(root, '0.21.0')
    const searchPath = [join(managed.path, '..'), join(user.command, '..'), '/usr/bin', '/bin'].join(delimiter)

    const selected = await resolveDesktopHermesSelection({
      env: {
        HOME: join(root, 'user'),
        HERMES_HOME: user.hermesHome,
        HERMES_BIN: managed.path,
        PATH: searchPath,
      },
      searchPath,
      hermesHome: user.hermesHome,
      managedRuntime: managed,
    })

    expect(selected).toMatchObject({
      source: 'user-cli',
      path: user.command,
      version: '0.20.5',
      pythonPath: user.python,
      agentRoot: user.agentRoot,
      environmentRoot: user.environmentRoot,
    })

    const env = withDesktopHermesSelection({
      HERMES_BIN: managed.path,
      HERMES_AGENT_CLI_PYTHON: managed.pythonPath,
      HERMES_AGENT_ROOT: managed.agentRoot,
    }, selected)
    expect(env).toMatchObject({
      HERMES_RUNTIME_SELECTION_LOCKED: 'true',
      HERMES_RUNTIME_SOURCE: 'user-cli',
      HERMES_BIN: user.command,
      HERMES_AGENT_BRIDGE_PYTHON: user.python,
      HERMES_AGENT_CLI_PYTHON: user.python,
      HERMES_AGENT_ROOT: user.agentRoot,
      VIRTUAL_ENV: user.environmentRoot,
    })
  })

  it('falls back to the managed Runtime when the user CLI probe fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-hermes-selection-'))
    temporaryDirectories.push(root)
    const user = userCli(join(root, 'user'), '0.20.5', false)
    const managed = managedRuntime(root, '0.21.0')
    const searchPath = [join(user.command, '..'), join(managed.path, '..'), '/usr/bin', '/bin'].join(delimiter)

    const selected = await resolveDesktopHermesSelection({
      env: { HOME: join(root, 'user'), HERMES_HOME: user.hermesHome, PATH: searchPath },
      searchPath,
      hermesHome: user.hermesHome,
      managedRuntime: managed,
    })

    expect(selected).toMatchObject({
      source: 'managed-runtime',
      path: managed.path,
      version: '0.21.0',
      pythonPath: managed.pythonPath,
      agentRoot: managed.agentRoot,
      managedRuntimeVersion: '0.21.0',
    })
  })

  it('locks an unavailable result without retaining stale Hermes variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-hermes-selection-'))
    temporaryDirectories.push(root)
    const selected = await resolveDesktopHermesSelection({
      env: { PATH: join(root, 'empty') },
      searchPath: join(root, 'empty'),
      hermesHome: join(root, '.hermes'),
    })

    expect(selected).toEqual({ source: 'none', path: '', version: '' })
    expect(withDesktopHermesSelection({
      HERMES_BIN: '/stale/hermes',
      HERMES_AGENT_CLI_PYTHON: '/stale/python',
      VIRTUAL_ENV: '/stale/venv',
    }, selected)).toMatchObject({
      HERMES_RUNTIME_SELECTION_LOCKED: 'true',
      HERMES_RUNTIME_SOURCE: 'none',
      HERMES_RUNTIME_VERSION: '',
    })
    expect(withDesktopHermesSelection({ HERMES_BIN: '/stale/hermes' }, selected).HERMES_BIN).toBeUndefined()
  })

  it('probes managed Runtimes sequentially with isolated PATH values and records the first failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-hermes-selection-'))
    temporaryDirectories.push(root)
    const attempts = join(root, 'attempts.log')
    const first = managedRuntime(root, '0.21.0', {
      name: 'first-runtime',
      pythonCommand: `#!/bin/sh\nprintf 'first\\n' >> "${attempts}"\nexit 23\n`,
    })
    first.probePath = [dirname(first.path), '/usr/bin', '/bin'].join(delimiter)
    const fallback = managedRuntime(root, '0.20.6', {
      name: 'fallback-runtime',
      pythonCommand: `#!/bin/sh\nprintf 'fallback\\n' >> "${attempts}"\ncase "$PATH" in *first-runtime*) exit 41;; esac\nprintf '0.20.6\\n'\n`,
    })
    fallback.probePath = [dirname(fallback.path), '/usr/bin', '/bin'].join(delimiter)

    const selected = await resolveDesktopHermesSelection({
      env: { PATH: [first.path, fallback.path].map(dirname).join(delimiter) },
      searchPath: '/usr/bin:/bin',
      hermesHome: join(root, '.hermes'),
      managedRuntimes: [first, fallback],
    })

    expect(selected).toMatchObject({
      source: 'managed-runtime',
      path: fallback.path,
      version: '0.20.6',
      managedRuntimeFailures: [{
        directory: first.directory,
        version: '0.21.0',
        reason: expect.stringContaining('(23)'),
      }],
    })
    expect(readFileSync(attempts, 'utf8').trim().split('\n')).toEqual(['first', 'fallback'])
  })

  it('checks cli.py after the offline import probe succeeds before falling back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-hermes-selection-'))
    temporaryDirectories.push(root)
    const attempts = join(root, 'agent-files-attempts.log')
    const incomplete = managedRuntime(root, '0.21.0', {
      name: 'missing-cli-runtime',
      pythonCommand: `#!/bin/sh\nprintf 'version-ok\\n' >> "${attempts}"\nprintf '0.21.0\\n'\n`,
    })
    rmSync(join(incomplete.agentRoot, 'cli.py'))
    incomplete.probePath = [dirname(incomplete.path), '/usr/bin', '/bin'].join(delimiter)
    const fallback = managedRuntime(root, '0.20.6', {
      name: 'complete-runtime',
      pythonCommand: `#!/bin/sh\nprintf 'fallback\\n' >> "${attempts}"\nprintf '0.20.6\\n'\n`,
    })
    fallback.probePath = [dirname(fallback.path), '/usr/bin', '/bin'].join(delimiter)

    const selected = await resolveDesktopHermesSelection({
      env: { PATH: '/usr/bin:/bin' },
      searchPath: '/usr/bin:/bin',
      hermesHome: join(root, '.hermes'),
      managedRuntimes: [incomplete, fallback],
    })

    expect(selected).toMatchObject({
      source: 'managed-runtime',
      path: fallback.path,
      managedRuntimeFailures: [{
        directory: incomplete.directory,
        reason: expect.stringContaining('cli.py'),
      }],
    })
    expect(readFileSync(attempts, 'utf8').trim().split('\n')).toEqual(['version-ok', 'fallback'])
  })
})
