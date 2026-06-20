import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import {
  resolveRuntimeResourceDir,
  runtimePlatformKey,
  type DesktopRuntimeResource,
} from './runtime-paths'
import { compareHermesAgentVersions, hermesAgentVersionFromRuntimeTag } from './runtime-version'

const isWin = platform() === 'win32'
const DEFAULT_HERMES_AGENT_VERSION = '0.15.2'
const MIN_COMPATIBLE_WEB_UI_VERSION = '0.6.14'
const PACKAGED_RUNTIME_RELEASE_NAME = 'runtime-release.json'
const ACTIVE_RUNTIME_VERSION_NAME = 'active-version.json'
let legacyWebUiVersionsCleaned = false

export function isPackaged() {
  return !!app?.isPackaged
}

function defaultWebuiDir(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'webui')
  return process.env.HERMES_WEB_UI_DIR?.trim() || resolve(app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop'), '..', '..')
}

export { runtimePlatformKey }

type RuntimeReleaseMetadata = {
  tag?: string
  hermesAgentVersion?: string
}

type ActiveRuntimeVersion = {
  platform?: unknown
  runtimeDirectory?: unknown
  webUiDirectory?: unknown
}

function runtimeRequiredFiles(root: string): string[] {
  const python = isWin ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3')
  const hermes = isWin ? join(root, 'python', 'Scripts', 'hermes.exe') : join(root, 'python', 'bin', 'hermes')
  const node = isWin ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node')
  const files = [python, hermes, node]
  if (isWin) files.push(join(root, 'git', 'cmd', 'git.exe'))
  return files
}

function runtimeDirectoryReady(root: string): boolean {
  return runtimeRequiredFiles(root).every(existsSync)
}

function readRuntimeManifestVersion(runtimeDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(runtimeDir, 'runtime-manifest.json'), 'utf-8')) as {
      hermesAgentVersion?: unknown
      asset?: { name?: unknown }
    }
    if (typeof manifest.hermesAgentVersion === 'string' && manifest.hermesAgentVersion.trim()) {
      return manifest.hermesAgentVersion.trim()
    }
    const assetName = typeof manifest.asset?.name === 'string' ? manifest.asset.name : ''
    const match = assetName.match(/hermes-agent-([^-]+)-/)
    return match?.[1] || null
  } catch {
    return null
  }
}

function installedRuntimeDirectories(): Array<{ directory: string; version: string }> {
  const root = join(webUiHome(), 'desktop-runtime', 'hermes')
  const currentPlatform = runtimePlatformKey()
  if (!existsSync(root)) return []

  const runtimes: Array<{ directory: string; version: string }> = []
  try {
    for (const versionEntry of readdirSync(root, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue
      const platformDir = join(root, versionEntry.name, currentPlatform)
      if (!runtimeDirectoryReady(platformDir)) continue
      runtimes.push({
        directory: platformDir,
        version: readRuntimeManifestVersion(platformDir) || versionEntry.name,
      })
    }
  } catch {
    return []
  }

  return runtimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
}

function activeRuntimeVersionFile(): string {
  return join(webUiHome(), 'desktop-runtime', ACTIVE_RUNTIME_VERSION_NAME)
}

function readActiveRuntimeVersion(): ActiveRuntimeVersion | null {
  const file = activeRuntimeVersionFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ActiveRuntimeVersion
  } catch {
    return null
  }
}

function cleanupLegacyWebUiVersions(): void {
  if (legacyWebUiVersionsCleaned) return
  legacyWebUiVersionsCleaned = true

  const root = join(webUiHome(), 'webui')
  if (!existsSync(root)) return

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name.trim().replace(/^v/, '')
      const comparison = compareHermesAgentVersions(version, MIN_COMPATIBLE_WEB_UI_VERSION)
      if (comparison === null || comparison >= 0) continue
      const target = join(root, entry.name)
      rmSync(target, { recursive: true, force: true })
      console.log(`[desktop] removed incompatible Web UI cache ${version}: ${target}`)
    }
  } catch (err) {
    console.warn('[desktop] failed to clean incompatible Web UI caches:', err instanceof Error ? err.message : String(err))
  }
}

// Bundled web-ui directory.
// dev:  <repo root> (or HERMES_WEB_UI_DIR)
// prod: <resources>/webui
// active-version.json can pin the Web UI path used to start the local server.
export function webuiDir(): string {
  const override = process.env.HERMES_WEB_UI_DIR?.trim()
  if (override) return resolve(override)

  cleanupLegacyWebUiVersions()

  const active = readActiveRuntimeVersion()
  if (active?.platform === runtimePlatformKey()
    && typeof active.webUiDirectory === 'string'
    && active.webUiDirectory.trim()
    && existsSync(active.webUiDirectory)) {
    return resolve(active.webUiDirectory)
  }

  return defaultWebuiDir()
}

export function webuiServerEntry(): string {
  return join(webuiDir(), 'dist', 'server', 'index.js')
}

function runtimeReleaseMetadata(): RuntimeReleaseMetadata | null {
  const candidates = isPackaged()
    ? [join(process.resourcesPath, 'build', PACKAGED_RUNTIME_RELEASE_NAME)]
    : [join(app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop'), 'build', PACKAGED_RUNTIME_RELEASE_NAME)]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as { tag?: unknown; hermesAgentVersion?: unknown }
      return {
        tag: typeof metadata.tag === 'string' && metadata.tag.trim() ? metadata.tag.trim() : undefined,
        hermesAgentVersion: typeof metadata.hermesAgentVersion === 'string' && metadata.hermesAgentVersion.trim()
          ? metadata.hermesAgentVersion.trim()
          : undefined,
      }
    } catch {}
  }

  return null
}

export function desktopRuntimeVersion(): string {
  const releaseTag = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG?.trim()
  const versionFromTag = hermesAgentVersionFromRuntimeTag(releaseTag)
  if (versionFromTag) return versionFromTag

  const metadata = runtimeReleaseMetadata()
  if (metadata?.hermesAgentVersion) return metadata.hermesAgentVersion

  const versionFromMetadataTag = hermesAgentVersionFromRuntimeTag(metadata?.tag)
  if (versionFromMetadataTag) return versionFromMetadataTag

  const versionOverride = process.env.HERMES_VERSION?.trim()
  if (versionOverride) return versionOverride

  return DEFAULT_HERMES_AGENT_VERSION
}

export function targetDesktopRuntimeDir(): string {
  const override = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()
  if (override) return resolve(override)
  return join(webUiHome(), 'desktop-runtime', 'hermes', desktopRuntimeVersion(), runtimePlatformKey())
}

export function desktopRuntimeDir(): string {
  const override = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()
  if (override) return resolve(override)

  const active = readActiveRuntimeVersion()
  if (active?.platform === runtimePlatformKey()
    && typeof active.runtimeDirectory === 'string'
    && active.runtimeDirectory.trim()
    && runtimeDirectoryReady(active.runtimeDirectory)) {
    return resolve(active.runtimeDirectory)
  }

  const installed = installedRuntimeDirectories()
  if (installed[0]) return resolve(installed[0].directory)

  return targetDesktopRuntimeDir()
}

function desktopAppPath(): string {
  return app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop')
}

export function runtimeResourceDir(name: DesktopRuntimeResource, packaged: boolean, appPath = desktopAppPath()): string {
  return resolveRuntimeResourceDir(name, packaged, appPath, desktopRuntimeDir(), runtimePlatformKey())
}

// dev:  packages/desktop/resources/python/<os>-<arch>
// prod: downloaded runtime cache under Web UI home.
export function pythonDir(): string {
  return runtimeResourceDir('python', isPackaged())
}

export function nodeDir(): string {
  return runtimeResourceDir('node', isPackaged())
}

export function nodeBinDir(): string {
  const dir = nodeDir()
  return isWin ? dir : join(dir, 'bin')
}

export function bundledNode(): string {
  return isWin ? join(nodeDir(), 'node.exe') : join(nodeBinDir(), 'node')
}

export function gitDir(): string {
  return runtimeResourceDir('git', isPackaged())
}

export function gitPathDirs(): string[] {
  if (!isWin) return []
  const dir = gitDir()
  return [
    join(dir, 'cmd'),
    join(dir, 'mingw64', 'bin'),
    // Do not expose Git for Windows' Unix toolchain on PATH. Its usr/bin
    // includes GNU tools like du.exe/find.exe, which can be picked up by
    // Hermes or subprocesses and recursively scan Windows profile/AppData
    // trees. We pass git.exe explicitly via HERMES_AGENT_GIT instead.
  ].filter(existsSync)
}

export function bundledGit(): string | undefined {
  if (!isWin) return undefined
  const git = join(gitDir(), 'cmd', 'git.exe')
  return existsSync(git) ? git : undefined
}

export function bundledAgentBrowserHome(): string {
  return join(pythonDir(), 'agent-browser')
}

function browserExecutableNames(): Set<string> {
  if (isWin) return new Set(['chrome.exe'])
  if (platform() === 'darwin') return new Set(['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chrome'])
  return new Set(['chrome', 'chromium', 'chromium-browser'])
}

export function bundledBrowserExecutable(): string | undefined {
  const names = browserExecutableNames()
  const stack = [join(bundledAgentBrowserHome(), 'browsers'), bundledAgentBrowserHome()].filter(existsSync)
  const visited = new Set<string>()

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir || visited.has(dir)) continue
    visited.add(dir)

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && names.has(entry.name)) return path
      if (entry.isDirectory()) stack.push(path)
    }
  }

  return undefined
}

export function pythonBinDir(): string {
  const dir = pythonDir()
  return isWin ? join(dir, 'Scripts') : join(dir, 'bin')
}

export function bundledPython(): string {
  const dir = pythonDir()
  return isWin ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
}

export function hermesBin(): string {
  return isWin ? join(pythonBinDir(), 'hermes.exe') : join(pythonBinDir(), 'hermes')
}

export function hermesBinExists(): boolean {
  return existsSync(hermesBin())
}

export function desktopIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'icon.png')
  return resolve(desktopAppPath(), 'build', 'icon.png')
}

export function desktopWindowsTrayIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'trayWindows.png')
  return resolve(desktopAppPath(), 'build', 'trayWindows.png')
}

export function desktopTrayTemplateIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'trayTemplate.png')
  return resolve(desktopAppPath(), 'build', 'trayTemplate.png')
}

export function webUiHome(): string {
  return process.env.HERMES_WEB_UI_HOME?.trim() || resolve(homedir(), '.hermes-web-ui')
}

export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()
  if (override) return resolve(override)

  const defaultHome = resolve(homedir(), '.hermes')

  if (isWin) {
    const candidates = [
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
    ]
      .map(value => value?.trim())
      .filter((value): value is string => !!value)
      .map(value => resolve(value, 'hermes'))

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }

  return defaultHome
}

export function tokenFile(): string {
  return join(webUiHome(), '.token')
}
