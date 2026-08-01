import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const SOURCE_RUNTIME_MIN_VERSION = '0.19.1'

export function runtimePlatformKey(platformName = platform(), archName = arch()) {
  const osLabel = platformName === 'win32' ? 'win' : platformName === 'darwin' ? 'mac' : platformName
  return `${osLabel}-${archName}`
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function runtimeVersion(runtimeRoot) {
  const manifest = readJson(join(runtimeRoot, 'runtime-manifest.json'))
  if (typeof manifest?.hermesAgentVersion === 'string' && manifest.hermesAgentVersion.trim()) {
    return manifest.hermesAgentVersion.trim().replace(/^v/, '')
  }
  return basename(dirname(runtimeRoot)).replace(/^v/, '')
}

function versionAtLeast(version, minimum) {
  const parse = value => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/)
    return match ? match.slice(1).map(Number) : null
  }
  const current = parse(version)
  const expected = parse(minimum)
  if (!current || !expected) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (current[index] !== expected[index]) return current[index] > expected[index]
  }
  return true
}

export function runtimeReady(runtimeRoot, platformName = platform()) {
  const isWin = platformName === 'win32'
  const sourceRuntime = versionAtLeast(runtimeVersion(runtimeRoot), SOURCE_RUNTIME_MIN_VERSION)
  const pythonRoot = sourceRuntime
    ? join(runtimeRoot, 'python', 'venv')
    : join(runtimeRoot, 'python')
  const required = isWin
    ? [
        sourceRuntime && existsSync(join(pythonRoot, 'Scripts', 'python.exe'))
          ? join(pythonRoot, 'Scripts', 'python.exe')
          : join(pythonRoot, 'python.exe'),
        join(pythonRoot, 'Scripts', 'hermes.cmd'),
        join(runtimeRoot, 'node', 'node.exe'),
        join(runtimeRoot, 'git', 'cmd', 'git.exe'),
      ]
    : [
        join(pythonRoot, 'bin', 'python3'),
        join(pythonRoot, 'bin', 'hermes'),
        join(runtimeRoot, 'node', 'bin', 'node'),
      ]
  return required.every(existsSync)
}

export function findCachedRuntime(webUiHome, platformName = platform(), archName = arch()) {
  const defaultRuntimeRoot = join(webUiHome, 'desktop-runtime')
  const platformKey = runtimePlatformKey(platformName, archName)
  const active = readJson(join(defaultRuntimeRoot, 'active-version.json'))
  const activeRuntime = typeof active?.runtimeDirectory === 'string' ? active.runtimeDirectory.trim() : ''
  if (active?.platform === platformKey && activeRuntime && runtimeReady(activeRuntime, platformName)) {
    return activeRuntime
  }

  const configuredRoot = typeof active?.runtimeRootDirectory === 'string' && active.runtimeRootDirectory.trim()
    ? resolve(active.runtimeRootDirectory.trim())
    : defaultRuntimeRoot
  const hermesRoot = join(configuredRoot, 'hermes')
  if (!existsSync(hermesRoot)) return ''
  try {
    return readdirSync(hermesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(hermesRoot, entry.name, platformKey))
      .filter(runtimeRoot => runtimeReady(runtimeRoot, platformName))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      [0] || ''
  } catch {
    return ''
  }
}
