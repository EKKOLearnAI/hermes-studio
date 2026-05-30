import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform, arch } from 'node:os'

const isWin = platform() === 'win32'
const osLabel = isWin ? 'win' : platform() === 'darwin' ? 'mac' : platform() // mac | linux | win
const archLabel = arch() // arm64 | x64

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

// Bundled Python directory.
// dev:  packages/desktop/resources/python/<os>-<arch>
// prod: <resources>/python
export function pythonDir(): string {
  if (app.isPackaged) return resolve(process.resourcesPath, 'python')
  return resolve(app.getAppPath(), 'resources', 'python', `${osLabel}-${archLabel}`)
}

export function hermesBin(): string {
  const dir = pythonDir()
  return isWin ? join(dir, 'Scripts', 'hermes.exe') : join(dir, 'bin', 'hermes')
}

export function hermesBinExists(): boolean {
  return existsSync(hermesBin())
}

export function desktopIcon(): string {
  if (app.isPackaged) return resolve(process.resourcesPath, 'build', 'icon.png')
  return resolve(app.getAppPath(), 'build', 'icon.png')
}

export function webUiHome(): string {
  return process.env.HERMES_WEB_UI_HOME?.trim() || resolve(homedir(), '.hermes-web-ui')
}

export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()
  if (override) return resolve(override)

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA?.trim() || process.env.APPDATA?.trim()
    if (localAppData) return resolve(localAppData, 'hermes')
  }

  return resolve(homedir(), '.hermes')
}

export function tokenFile(): string {
  return join(webUiHome(), '.token')
}
