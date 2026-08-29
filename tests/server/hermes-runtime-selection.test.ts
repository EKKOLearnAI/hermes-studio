import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
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

function createManagedRuntime(root: string, version: string): string {
  const runtime = join(root, 'desktop-runtime', 'hermes', version, platformKey())
  const environmentBin = join(runtime, 'python', 'venv', 'bin')
  const managedCli = cli(environmentBin, version)
  writeFileSync(join(environmentBin, 'python3'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(environmentBin, 'python3'), 0o755)
  mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'node', 'bin', 'node'), '')
  writeFileSync(join(runtime, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: platformKey(),
    hermesAgentVersion: version,
  }))
  writeFileSync(join(root, 'desktop-runtime', 'active-version.json'), JSON.stringify({
    schema: 1,
    hermesRuntimeVersion: version,
    runtimeDirectory: runtime,
    platform: platformKey(),
  }))
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
    const userCli = cli(join(state.appHome, 'user-bin'), '0.20.4')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_BIN: managedCli,
      HERMES_AGENT_BRIDGE_PYTHON: '/old/runtime/python',
      PATH: [join(managedCli, '..'), join(userCli, '..'), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)

    expect(selected).toMatchObject({ source: 'user-cli', path: userCli, version: '0.20.4' })
    expect(env.HERMES_BIN).toBe(userCli)
    expect(env.HERMES_AGENT_BRIDGE_PYTHON).toBeUndefined()
  })

  it('uses the active managed Runtime when no user CLI exists', async () => {
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-selection-'))
    temporaryDirectories.push(state.appHome)
    const managedCli = createManagedRuntime(state.appHome, '0.21.0')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_BIN: managedCli,
      PATH: [join(managedCli, '..'), '/usr/bin', '/bin'].join(delimiter),
    }

    const { configurePreferredHermesRuntime } = await import('../../packages/server/src/modules/hermes/services/runtime/selection')
    const selected = await configurePreferredHermesRuntime(env)

    expect(selected).toMatchObject({ source: 'managed-runtime', path: managedCli, version: '0.21.0' })
    expect(env.HERMES_AGENT_BRIDGE_PYTHON).toBe(join(state.appHome, 'desktop-runtime', 'hermes', '0.21.0', platformKey(), 'python', 'venv', 'bin', 'python3'))
  })
})
