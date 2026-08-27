import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import { discoverHermesCliInstallations, type HermesCliInstallation } from './discovery'
import { listInstalledRuntimeVersions, readActiveVersionManifest, type InstalledRuntimeVersion } from './version-manager'

export interface HermesRuntimeSelection {
  source: 'user-cli' | 'managed-runtime' | 'none'
  path: string
  version: string
  managedRuntimeVersion?: string
}

function prependPath(env: NodeJS.ProcessEnv, entries: string[]): void {
  const current = env.PATH || env.Path || ''
  const seen = new Set<string>()
  const merged = [...entries, ...current.split(delimiter)]
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry) return false
      const key = process.platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  env.PATH = merged.join(delimiter)
}

function clearManagedRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of [
    'HERMES_AGENT_BRIDGE_PYTHON',
    'HERMES_AGENT_CLI_PYTHON',
    'HERMES_AGENT_ROOT',
    'VIRTUAL_ENV',
    'UV_PROJECT_ENVIRONMENT',
    'UV_PYTHON',
    'UV_SYSTEM_PYTHON',
  ]) {
    delete env[name]
  }
}

function pythonEnvironmentRoot(runtimeDirectory: string): string {
  const sourceRoot = join(runtimeDirectory, 'python')
  const venvRoot = join(sourceRoot, 'venv')
  const candidates = process.platform === 'win32'
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')]
    : [join(venvRoot, 'bin', 'python3')]
  return candidates.some(existsSync) ? venvRoot : sourceRoot
}

function managedRuntimePaths(runtime: InstalledRuntimeVersion) {
  const runtimeDirectory = runtime.directory
  const pythonRoot = join(runtimeDirectory, 'python')
  const environmentRoot = pythonEnvironmentRoot(runtimeDirectory)
  const scriptsRoot = process.platform === 'win32'
    ? join(environmentRoot, 'Scripts')
    : join(environmentRoot, 'bin')
  const python = process.platform === 'win32'
    ? (existsSync(join(scriptsRoot, 'python.exe')) ? join(scriptsRoot, 'python.exe') : join(environmentRoot, 'python.exe'))
    : join(scriptsRoot, 'python3')
  const commandWrapper = join(scriptsRoot, 'hermes.cmd')
  const commandExecutable = join(scriptsRoot, 'hermes.exe')
  const hermes = process.platform === 'win32'
    ? (existsSync(commandWrapper) || !existsSync(commandExecutable) ? commandWrapper : commandExecutable)
    : join(scriptsRoot, 'hermes')
  const nodeRoot = join(runtimeDirectory, 'node')
  const nodeBin = process.platform === 'win32' ? nodeRoot : join(nodeRoot, 'bin')
  const node = process.platform === 'win32' ? join(nodeRoot, 'node.exe') : join(nodeBin, 'node')
  const git = process.platform === 'win32' ? join(runtimeDirectory, 'git', 'cmd', 'git.exe') : ''
  return { pythonRoot, environmentRoot, scriptsRoot, python, hermes, nodeRoot, nodeBin, node, git }
}

function applyUserCli(env: NodeJS.ProcessEnv, installation: HermesCliInstallation): HermesRuntimeSelection {
  clearManagedRuntimeEnvironment(env)
  env.HERMES_BIN = installation.path
  prependPath(env, [dirname(installation.path)])
  return {
    source: 'user-cli',
    path: installation.path,
    version: installation.version,
  }
}

function applyManagedRuntime(env: NodeJS.ProcessEnv, runtime: InstalledRuntimeVersion): HermesRuntimeSelection {
  const paths = managedRuntimePaths(runtime)
  env.HERMES_BIN = paths.hermes
  env.HERMES_AGENT_BRIDGE_PYTHON = paths.python
  env.HERMES_AGENT_CLI_PYTHON = paths.python
  env.HERMES_AGENT_ROOT = paths.pythonRoot
  env.VIRTUAL_ENV = paths.environmentRoot
  env.UV_PROJECT_ENVIRONMENT = paths.environmentRoot
  env.UV_PYTHON = paths.python
  if (process.platform !== 'win32') env.UV_SYSTEM_PYTHON = '1'
  env.HERMES_AGENT_NODE = paths.node
  env.HERMES_AGENT_NODE_ROOT = paths.nodeRoot
  env.AGENT_BROWSER_HOME ||= join(paths.pythonRoot, 'agent-browser')
  env.PLAYWRIGHT_BROWSERS_PATH ||= join(paths.pythonRoot, 'ms-playwright')
  if (paths.git && existsSync(paths.git)) env.HERMES_AGENT_GIT = paths.git
  prependPath(env, [paths.scriptsRoot, paths.nodeBin, paths.git ? dirname(paths.git) : ''])
  return {
    source: 'managed-runtime',
    path: paths.hermes,
    version: runtime.manifestHermesRuntimeVersion || runtime.version,
    managedRuntimeVersion: runtime.version,
  }
}

/**
 * Select the Hermes executable for this server process.
 *
 * A user-owned CLI always wins. Studio Runtime is only used when no user CLI
 * is visible, which keeps Web UI and Desktop selection behavior identical.
 */
export async function configurePreferredHermesRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesRuntimeSelection> {
  const active = readActiveVersionManifest()
  const installed = listInstalledRuntimeVersions(active)
  const installations = await discoverHermesCliInstallations(installed, env)
  const userCli = installations.find(item => item.source === 'user-cli' && Boolean(item.path))
  if (userCli) return applyUserCli(env, userCli)

  const activeRuntime = installed.find(item => item.active)
    || installed.find(item => item.platform === `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform}-${process.arch}`)
  if (activeRuntime) return applyManagedRuntime(env, activeRuntime)

  if (env.HERMES_BIN && !existsSync(env.HERMES_BIN)) delete env.HERMES_BIN
  clearManagedRuntimeEnvironment(env)
  return { source: 'none', path: '', version: '' }
}
