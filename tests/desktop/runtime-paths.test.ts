import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockElectronApp = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.6.11',
  getLocale: () => 'en',
}))

vi.mock('electron', () => ({
  app: mockElectronApp,
}))

const originalEnv = { ...process.env }
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-desktop-runtime-paths-'))
  tempDirs.push(dir)
  return dir
}

describe('desktop runtime paths', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    const resourcesPath = tempDir()
    process.resourcesPath = resourcesPath
    process.env.HERMES_WEB_UI_HOME = tempDir()
    mockElectronApp.isPackaged = false
    mockElectronApp.getAppPath = () => process.cwd()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the downloaded runtime in packaged builds even when stale install resources exist', async () => {
    mkdirSync(join(process.resourcesPath, 'python'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'node'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'git'), { recursive: true })

    const { resolveRuntimeResourceDir } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'python'))
    expect(resolveRuntimeResourceDir('node', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'node'))
    expect(resolveRuntimeResourceDir('git', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'git'))
  })

  it('uses app resources for development runtime paths', async () => {
    const appPath = tempDir()
    const { resolveRuntimeResourceDir, runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'python', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('node', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'node', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('git', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'git', runtimePlatformKey()))
  })

  it('uses active-version.json paths for startup while keeping the current target runtime path', async () => {
    const homeDir = tempDir()
    const appPath = tempDir()
    const runtimeDir = tempDir()
    const webUiDir = tempDir()
    process.env.HERMES_WEB_UI_HOME = homeDir
    mockElectronApp.getAppPath = () => appPath

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    mkdirSync(join(homeDir, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(homeDir, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.15.1',
      webUiVersion: '0.6.10',
      runtimeDirectory: runtimeDir,
      webUiDirectory: webUiDir,
      platform: runtimePlatformKey(),
    }))

    const { desktopRuntimeDir, targetDesktopRuntimeDir, webuiDir } = await import('../../packages/desktop/src/main/paths')

    expect(desktopRuntimeDir()).toBe(runtimeDir)
    expect(webuiDir()).toBe(webUiDir)
    expect(targetDesktopRuntimeDir()).toBe(join(homeDir, 'desktop-runtime', 'hermes', '0.15.2', runtimePlatformKey()))
  })
})
