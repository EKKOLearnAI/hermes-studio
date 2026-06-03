import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import {
  resolveRuntimeResourceDir,
  runtimePlatformKey,
  type DesktopRuntimeResource,
} from './runtime-paths'

const isWin = platform() === 'win32'

export function isPackaged() {
  return app.isPackaged
}

// Bundled web-ui directory.
// dev:  <repo root> (or HERMES_WEB_UI_DIR)
// prod: <resources>/webui
export function webuiDir(): string {
  if (app.isPackaged) return resolve(process.resourcesPath, 'webui')
  return process.env.HERMES_WEB_UI_DIR?.trim() || resolve(app.getAppPath(), '..', '..')
}

export function webuiServerEntry(): string {
  return join(webuiDir(), 'dist', 'server', 'index.js')
}

export { runtimePlatformKey }

export function desktopRuntimeDir(): string {
  const override = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()
  if (override) return resolve(override)
  return join(webUiHome(), 'desktop-runtime', runtimePlatformKey())
}

export function runtimeResourceDir(name: DesktopRuntimeResource, packaged: boolean, appPath = app.getAppPath()): string {
  return resolveRuntimeResourceDir(name, packaged, appPath, desktopRuntimeDir(), runtimePlatformKey())
}

// dev:  packages/desktop/resources/python/<os>-<arch>
// prod: downloaded runtime cache under Web UI home.
export function pythonDir(): string {
  return runtimeResourceDir('python', app.isPackaged)
}

export function nodeDir(): string {
  return runtimeResourceDir('node', app.isPackaged)
}

export function nodeBinDir(): string {
  const dir = nodeDir()
  return isWin ? dir : join(dir, 'bin')
}

export function bundledNode(): string {
  return isWin ? join(nodeDir(), 'node.exe') : join(nodeBinDir(), 'node')
}

export function gitDir(): string {
  return runtimeResourceDir('git', app.isPackaged)
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
  if (app.isPackaged) return resolve(process.resourcesPath, 'build', 'icon.png')
  return resolve(app.getAppPath(), 'build', 'icon.png')
}

export function desktopWindowsTrayIcon(): string {
  if (app.isPackaged) return resolve(process.resourcesPath, 'build', 'trayWindows.png')
  return resolve(app.getAppPath(), 'build', 'trayWindows.png')
}

export function desktopTrayTemplateIcon(): string {
  if (app.isPackaged) return resolve(process.resourcesPath, 'build', 'trayTemplate.png')
  return resolve(app.getAppPath(), 'build', 'trayTemplate.png')
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
