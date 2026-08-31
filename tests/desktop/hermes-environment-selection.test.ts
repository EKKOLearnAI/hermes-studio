import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
    `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`,
  )
  const agentCommand = join(agentRoot, 'hermes')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  writeFileSync(agentCommand, '')
  const command = executable(
    join(root, '.local', 'bin', 'hermes'),
    succeeds
      ? `#!/bin/sh\nexec "${python}" "${agentCommand}" "$@"\n`
      : '#!/bin/sh\nexit 1\n',
  )
  return { command, python, agentRoot, environmentRoot, hermesHome }
}

function managedRuntime(root: string, version: string): DesktopManagedHermesRuntime {
  const directory = join(root, 'managed-runtime')
  const agentRoot = join(directory, 'python')
  const environmentRoot = join(agentRoot, 'venv')
  const pythonPath = executable(join(environmentRoot, 'bin', 'python3'), '#!/bin/sh\nexit 0\n')
  const path = executable(
    join(environmentRoot, 'bin', 'hermes'),
    `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`,
  )
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  return { directory, path, pythonPath, agentRoot, environmentRoot, managedRuntimeVersion: version }
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
})
