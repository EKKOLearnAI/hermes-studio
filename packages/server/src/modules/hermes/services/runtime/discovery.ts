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
  error?: string
}

export interface HermesCliDiscoveryOptions {
  source?: 'all' | HermesCliInstallation['source']
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

function versionProbeError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string | Buffer }
  const stderr = typeof detail?.stderr === 'string'
    ? detail.stderr.trim()
    : Buffer.isBuffer(detail?.stderr) ? detail.stderr.toString('utf8').trim() : ''
  if (detail?.killed || detail?.code === 'ETIMEDOUT') return 'hermes --version timed out after 5000ms'
  const code = detail?.code !== undefined ? ` (${String(detail.code)})` : ''
  const message = error instanceof Error ? error.message.replace(/^Error:\s*/, '').trim() : String(error)
  return `hermes --version failed${code}: ${stderr || message || 'unknown error'}`
}

export async function probeHermesCliVersion(
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<{ version: string; error: string }> {
  try {
    const result = await execHermesWithBin(path, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    const version = normalizeVersion(result.stdout)
    return version
      ? { version, error: '' }
      : { version: '', error: 'hermes --version returned an empty version' }
  } catch (firstError) {
    if (process.platform !== 'win32' || !windowsCommandNeedsShell(path)) {
      return { version: '', error: versionProbeError(firstError) }
    }
    try {
      const execution = windowsCmdShimExecution(path, ['--version'])
      const { stdout } = await execFileAsync(execution.command, execution.args, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        windowsVerbatimArguments: execution.windowsVerbatimArguments,
        env,
      })
      const version = normalizeVersion(String(stdout || ''))
      return version
        ? { version, error: '' }
        : { version: '', error: 'hermes --version returned an empty version' }
    } catch (fallbackError) {
      return { version: '', error: versionProbeError(fallbackError) }
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
  options: HermesCliDiscoveryOptions = {},
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

  const installations: HermesCliInstallation[] = []
  for (const path of uniqueCandidates) {
    const canonical = canonicalPath(path)
    const managedRuntime = managedRuntimes.find(runtime => {
      const runtimeDirectory = canonicalPath(runtime.directory)
      return isPathWithin(canonical, runtimeDirectory)
    })
    const source = managedRuntime ? 'managed-runtime' : 'user-cli'
    if (options.source && options.source !== 'all' && options.source !== source) continue
    const probe = await probeHermesCliVersion(path, env)
    installations.push({
      path,
      version: probe.version,
      source,
      selected: comparablePath(path) === selectedPath,
      ...(managedRuntime ? { managedRuntimeVersion: managedRuntime.version } : {}),
      ...(probe.error ? { error: probe.error } : {}),
    })
  }
  return installations
}
