import { execFile } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { promisify } from 'util'
import {
  normalizeWindowsCommandPath,
  windowsCmdShimExecution,
  windowsCommandNeedsShell,
} from '../../../studio/public/windows-command'
import { isPathWithin } from './path'
import { execHermesWithBin, resolveHermesBin } from './process'

const execFileAsync = promisify(execFile)

export interface HermesManagedRuntimeLocation {
  version: string
  directory: string
}

export interface HermesCliInstallation {
  path: string
  version: string
  source: 'managed-runtime' | 'user-cli'
  selected: boolean
  managedRuntimeVersion?: string
}

function canonicalPath(path: string): string {
  const normalized = normalizeWindowsCommandPath(path)
  try {
    return realpathSync(normalized)
  } catch {
    return resolve(normalized)
  }
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\')
}

async function findHermesCommandPaths(env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const lookupArgs = process.platform === 'win32' ? ['hermes'] : ['-a', 'hermes']
    const { stdout } = await execFileAsync(lookupCommand, lookupArgs, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    return String(stdout || '')
      .split(/\r?\n/)
      .map(line => normalizeWindowsCommandPath(line.trim()))
      .filter(Boolean)
  } catch {
    return []
  }
}

function normalizeVersion(raw: string): string {
  return raw
    .split(/\r?\n/)[0]
    ?.replace(/^Hermes(?: Agent)?\s+/i, '')
    .trim() || ''
}

async function readHermesCliVersion(path: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execHermesWithBin(path, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    return normalizeVersion(result.stdout)
  } catch {
    if (process.platform !== 'win32' || !windowsCommandNeedsShell(path)) return ''
    try {
      const execution = windowsCmdShimExecution(path, ['--version'])
      const { stdout } = await execFileAsync(execution.command, execution.args, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        windowsVerbatimArguments: execution.windowsVerbatimArguments,
        env,
      })
      return normalizeVersion(String(stdout || ''))
    } catch {
      return ''
    }
  }
}

/**
 * Discover every Hermes CLI visible to the running Studio process.
 *
 * Paths inside a downloaded Desktop Runtime are managed by Studio. Any other
 * installation belongs to the user and is deliberately exposed as read-only.
 */
export async function discoverHermesCliInstallations(
  managedRuntimes: HermesManagedRuntimeLocation[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesCliInstallation[]> {
  const configuredBin = resolveHermesBin(env.HERMES_BIN)
  const commandPaths = await findHermesCommandPaths(env)
  const candidates = [
    ...(isPathLike(configuredBin) ? [configuredBin] : []),
    ...commandPaths,
  ]
  const uniqueCandidates = [...new Map(
    candidates
      .filter(path => path && (existsSync(path) || !isPathLike(path)))
      .map(path => [comparablePath(path), normalizeWindowsCommandPath(path)]),
  ).values()]

  const configuredPath = isPathLike(configuredBin) ? comparablePath(configuredBin) : ''
  const selectedPath = configuredPath && uniqueCandidates.some(path => comparablePath(path) === configuredPath)
    ? configuredPath
    : uniqueCandidates[0] ? comparablePath(uniqueCandidates[0]) : ''

  return Promise.all(uniqueCandidates.map(async path => {
    const canonical = canonicalPath(path)
    const managedRuntime = managedRuntimes.find(runtime => {
      const runtimeDirectory = canonicalPath(runtime.directory)
      return isPathWithin(canonical, runtimeDirectory)
    })
    return {
      path,
      version: await readHermesCliVersion(path, env),
      source: managedRuntime ? 'managed-runtime' : 'user-cli',
      selected: comparablePath(path) === selectedPath,
      ...(managedRuntime ? { managedRuntimeVersion: managedRuntime.version } : {}),
    }
  }))
}
