import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockElectronApp = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.6.21',
  getLocale: () => 'en',
}))

vi.mock('electron', () => ({
  app: mockElectronApp,
}))

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []
const servers: Server[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createRuntimeFiles(root: string) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(root, 'python', 'bin'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform}-${process.arch}`,
    hermesAgentVersion: '0.17.0',
    asset: { name: 'hermes-runtime-test.tar.gz' },
  }))
}

function createWebUiFiles(root: string, version = '0.6.31') {
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(root, 'bin', 'hermes-web-ui.mjs'), '')
  writeFileSync(join(root, 'dist', 'server', 'index.js'), '')
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

async function createRuntimeArchive(): Promise<string> {
  const source = tempDir('hermes-runtime-source-')
  const archive = join(tempDir('hermes-runtime-archive-'), 'hermes-runtime-test.tar.gz')
  createRuntimeFiles(source)
  await tar.c({ gzip: true, cwd: source, file: archive }, ['.'])
  return archive
}

async function serveFile(file: string): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== '/hermes-runtime-test.tar.gz') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    createReadStream(file).pipe(response)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port')
  return `http://127.0.0.1:${address.port}/hermes-runtime-test.tar.gz`
}

describe('desktop runtime manager', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    process.env.HERMES_WEB_UI_HOME = tempDir('hermes-runtime-home-')
    process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG = 'hermes-0.17.0-runtime'
    mockElectronApp.isPackaged = false
    mockElectronApp.getAppPath = () => process.cwd()
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.resetModules()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('downloads through a unique temp file instead of reusing a stale runtime .download path', async () => {
    const archive = await createRuntimeArchive()
    process.env.HERMES_DESKTOP_RUNTIME_URL = await serveFile(archive)

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const staleDownloadPath = join(
      process.env.HERMES_WEB_UI_HOME!,
      'desktop-runtime',
      'hermes',
      '0.17.0',
      'hermes-runtime-test.tar.gz.download',
    )
    mkdirSync(staleDownloadPath, { recursive: true })

    const { ensureDesktopRuntime } = await import('../../packages/desktop/src/main/runtime-manager')
    await ensureDesktopRuntime()

    const runtimeRoot = join(
      process.env.HERMES_WEB_UI_HOME!,
      'desktop-runtime',
      'hermes',
      '0.17.0',
      runtimePlatformKey(),
    )
    expect(existsSync(staleDownloadPath)).toBe(true)
    expect(existsSync(join(runtimeRoot, 'runtime-manifest.json'))).toBe(true)
    expect(existsSync(join(process.env.HERMES_WEB_UI_HOME!, 'desktop-runtime', 'active-version.json'))).toBe(true)
  })

  it('accepts Windows runtime archives that contain hermes.cmd without hermes.exe', async () => {
    setPlatform('win32')
    const archive = await createRuntimeArchive()
    process.env.HERMES_DESKTOP_RUNTIME_URL = await serveFile(archive)

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const { ensureDesktopRuntime } = await import('../../packages/desktop/src/main/runtime-manager')
    await ensureDesktopRuntime()

    const runtimeRoot = join(
      process.env.HERMES_WEB_UI_HOME!,
      'desktop-runtime',
      'hermes',
      '0.17.0',
      runtimePlatformKey(),
    )
    expect(existsSync(join(runtimeRoot, 'python', 'Scripts', 'hermes.cmd'))).toBe(true)
    expect(existsSync(join(runtimeRoot, 'python', 'Scripts', 'hermes.exe'))).toBe(false)
  })

  it('does not persist a development Web UI override as the active download directory', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const developmentWebUi = tempDir('hermes-development-webui-')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = join(home, 'desktop-runtime', 'hermes', '0.17.0', runtimePlatformKey())
    const activeVersionPath = join(home, 'desktop-runtime', 'active-version.json')
    createRuntimeFiles(runtimeRoot)
    process.env.HERMES_WEB_UI_DIR = developmentWebUi
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true })
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      webUiVersion: '0.6.31',
      webUiDirectory: developmentWebUi,
      platform: runtimePlatformKey(),
    }))

    const { writeActiveRuntimeVersion } = await import('../../packages/desktop/src/main/runtime-manager')
    writeActiveRuntimeVersion(runtimeRoot)
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(active.webUiVersion).toBe('0.6.31')
    expect(active.webUiDirectory).toBeUndefined()
  })

  it('copies a pending Runtime migration before switching the active directory', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const destination = tempDir('hermes-runtime-migration-target-')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const sourceRuntime = join(home, 'desktop-runtime', 'hermes', '0.17.0', runtimePlatformKey())
    const sourceWebUi = join(home, 'desktop-runtime', 'webui', '0.6.31')
    const activeVersionPath = join(home, 'desktop-runtime', 'active-version.json')
    createRuntimeFiles(sourceRuntime)
    createWebUiFiles(sourceWebUi)
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.17.0',
      runtimeDirectory: sourceRuntime,
      webUiVersion: '0.6.31',
      webUiDirectory: sourceWebUi,
      pendingRuntimeRootDirectory: destination,
      platform: runtimePlatformKey(),
    }))

    const onProgress = vi.fn()
    const { migratePendingRuntimeRoot } = await import('../../packages/desktop/src/main/runtime-manager')
    const result = await migratePendingRuntimeRoot(onProgress)
    const migratedRuntime = join(destination, 'hermes', '0.17.0', runtimePlatformKey())
    const migratedWebUi = join(destination, 'webui', '0.6.31')
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(result).toEqual({ migrated: true, error: '' })
    expect(existsSync(join(migratedRuntime, 'runtime-manifest.json'))).toBe(true)
    expect(existsSync(join(sourceRuntime, 'runtime-manifest.json'))).toBe(true)
    expect(existsSync(join(migratedWebUi, 'dist', 'server', 'index.js'))).toBe(true)
    expect(existsSync(join(sourceWebUi, 'dist', 'server', 'index.js'))).toBe(true)
    expect(active.runtimeDirectory).toBe(migratedRuntime)
    expect(active.runtimeRootDirectory).toBe(destination)
    expect(active.webUiVersion).toBe('0.6.31')
    expect(active.webUiDirectory).toBeUndefined()
    expect(active.pendingRuntimeRootDirectory).toBeUndefined()
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'extract',
      detail: destination,
    }))
  })

  it('reuses valid Runtime and Web UI versions in a custom destination', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const destination = tempDir('hermes-runtime-migration-existing-target-')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const sourceRuntime = join(home, 'desktop-runtime', 'hermes', '0.17.0', runtimePlatformKey())
    const sourceWebUi30 = join(home, 'desktop-runtime', 'webui', '0.6.30')
    const sourceWebUi31 = join(home, 'desktop-runtime', 'webui', '0.6.31')
    const targetRuntime = join(destination, 'hermes', '0.17.0', runtimePlatformKey())
    const targetWebUi31 = join(destination, 'webui', '0.6.31')
    const activeVersionPath = join(home, 'desktop-runtime', 'active-version.json')
    createRuntimeFiles(sourceRuntime)
    createRuntimeFiles(targetRuntime)
    createWebUiFiles(sourceWebUi30, '0.6.30')
    createWebUiFiles(sourceWebUi31)
    createWebUiFiles(targetWebUi31)
    writeFileSync(join(sourceRuntime, 'source-only.txt'), '')
    writeFileSync(join(targetRuntime, 'target-only.txt'), '')
    writeFileSync(join(sourceWebUi31, 'source-only.txt'), '')
    writeFileSync(join(targetWebUi31, 'target-only.txt'), '')
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.17.0',
      runtimeDirectory: sourceRuntime,
      webUiVersion: '0.6.31',
      pendingRuntimeRootDirectory: destination,
      platform: runtimePlatformKey(),
    }))

    const { migratePendingRuntimeRoot } = await import('../../packages/desktop/src/main/runtime-manager')
    const result = await migratePendingRuntimeRoot()
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(result).toEqual({ migrated: true, error: '' })
    expect(existsSync(join(targetRuntime, 'target-only.txt'))).toBe(true)
    expect(existsSync(join(targetRuntime, 'source-only.txt'))).toBe(false)
    expect(existsSync(join(targetWebUi31, 'target-only.txt'))).toBe(true)
    expect(existsSync(join(targetWebUi31, 'source-only.txt'))).toBe(false)
    expect(existsSync(join(destination, 'webui', '0.6.30', 'dist', 'server', 'index.js'))).toBe(true)
    expect(active.runtimeDirectory).toBe(targetRuntime)
    expect(active.runtimeRootDirectory).toBe(destination)
  })

  it('switches back to an already valid default directory without copying', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const defaultRoot = join(home, 'desktop-runtime')
    const customRoot = tempDir('hermes-runtime-migration-current-custom-')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const sourceRuntime = join(customRoot, 'hermes', '0.17.0', runtimePlatformKey())
    const sourceWebUi = join(customRoot, 'webui', '0.6.31')
    const targetRuntime = join(defaultRoot, 'hermes', '0.17.0', runtimePlatformKey())
    const targetWebUi = join(defaultRoot, 'webui', '0.6.31')
    const activeVersionPath = join(defaultRoot, 'active-version.json')
    createRuntimeFiles(sourceRuntime)
    createRuntimeFiles(targetRuntime)
    createWebUiFiles(sourceWebUi)
    createWebUiFiles(targetWebUi)
    writeFileSync(join(sourceRuntime, 'source-only.txt'), '')
    writeFileSync(join(targetRuntime, 'target-only.txt'), '')
    writeFileSync(join(sourceWebUi, 'source-only.txt'), '')
    writeFileSync(join(targetWebUi, 'target-only.txt'), '')
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.17.0',
      runtimeDirectory: sourceRuntime,
      runtimeRootDirectory: customRoot,
      webUiVersion: '0.6.31',
      pendingRuntimeRootDirectory: defaultRoot,
      platform: runtimePlatformKey(),
    }))

    const onProgress = vi.fn()
    const { migratePendingRuntimeRoot } = await import('../../packages/desktop/src/main/runtime-manager')
    const result = await migratePendingRuntimeRoot(onProgress)
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(result).toEqual({ migrated: true, error: '' })
    expect(onProgress).not.toHaveBeenCalled()
    expect(existsSync(join(targetRuntime, 'target-only.txt'))).toBe(true)
    expect(existsSync(join(targetRuntime, 'source-only.txt'))).toBe(false)
    expect(existsSync(join(targetWebUi, 'target-only.txt'))).toBe(true)
    expect(existsSync(join(targetWebUi, 'source-only.txt'))).toBe(false)
    expect(active.runtimeDirectory).toBe(targetRuntime)
    expect(active.runtimeRootDirectory).toBe(defaultRoot)
    expect(active.pendingRuntimeRootDirectory).toBeUndefined()
  })

  it('keeps the previous Runtime selected when a pending migration fails', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const destination = tempDir('hermes-runtime-migration-failure-')
    const missingRuntime = join(home, 'missing-runtime')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const activeVersionPath = join(home, 'desktop-runtime', 'active-version.json')
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true })
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.17.0',
      runtimeDirectory: missingRuntime,
      pendingRuntimeRootDirectory: destination,
      platform: runtimePlatformKey(),
    }))

    const { migratePendingRuntimeRoot } = await import('../../packages/desktop/src/main/runtime-manager')
    const result = await migratePendingRuntimeRoot()
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(result.migrated).toBe(false)
    expect(result.error).toContain('Current Runtime is incomplete')
    expect(active.runtimeDirectory).toBe(missingRuntime)
    expect(active.runtimeRootDirectory).toBeUndefined()
    expect(active.pendingRuntimeRootDirectory).toBeUndefined()
    expect(active.runtimeMigrationError).toContain('Current Runtime is incomplete')
  })

  it('does not switch storage when a downloaded Web UI version fails validation', async () => {
    const home = process.env.HERMES_WEB_UI_HOME!
    const destination = tempDir('hermes-runtime-migration-webui-failure-')
    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const sourceRuntime = join(home, 'desktop-runtime', 'hermes', '0.17.0', runtimePlatformKey())
    const sourceWebUi = join(home, 'desktop-runtime', 'webui', '0.6.31')
    const activeVersionPath = join(home, 'desktop-runtime', 'active-version.json')
    createRuntimeFiles(sourceRuntime)
    mkdirSync(sourceWebUi, { recursive: true })
    writeFileSync(join(sourceWebUi, 'package.json'), JSON.stringify({ version: '0.6.31' }))
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.17.0',
      runtimeDirectory: sourceRuntime,
      webUiVersion: '0.6.31',
      webUiDirectory: sourceWebUi,
      pendingRuntimeRootDirectory: destination,
      platform: runtimePlatformKey(),
    }))

    const { migratePendingRuntimeRoot } = await import('../../packages/desktop/src/main/runtime-manager')
    const result = await migratePendingRuntimeRoot()
    const active = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(result.migrated).toBe(false)
    expect(result.error).toContain('Web UI 0.6.31 is missing required files')
    expect(active.runtimeDirectory).toBe(sourceRuntime)
    expect(active.runtimeRootDirectory).toBeUndefined()
    expect(active.webUiVersion).toBe('0.6.31')
    expect(active.webUiDirectory).toBeUndefined()
    expect(existsSync(join(destination, 'hermes', '0.17.0', runtimePlatformKey()))).toBe(false)
  })
})
