import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ appHome: '' }))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    get appHome() {
      return state.appHome
    },
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  getHermesAgentVersion: () => 'v2026.8.1',
  getHermesWebUiVersion: () => '0.6.31',
}))

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

function runtimePlatformKey(): string {
  const osLabel = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
  return `${osLabel}-${process.arch}`
}

function createRuntime(root: string, version: string, options: { missingNode?: boolean } = {}): void {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'venv', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'venv', 'Scripts', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'venv', 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
    if (!options.missingNode) {
      mkdirSync(join(root, 'node'), { recursive: true })
      writeFileSync(join(root, 'node', 'node.exe'), '')
    }
  } else {
    mkdirSync(join(root, 'python', 'venv', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'venv', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'venv', 'bin', 'hermes'), '')
    if (!options.missingNode) {
      mkdirSync(join(root, 'node', 'bin'), { recursive: true })
      writeFileSync(join(root, 'node', 'bin', 'node'), '')
    }
  }
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: runtimePlatformKey(),
    hermesAgentVersion: version,
  }))
}

describe('runtime version manager storage migration', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    process.env.HERMES_DESKTOP = 'true'
    delete process.env.HERMES_DESKTOP_RUNTIME_DIR
    delete process.env.HERMES_WEB_UI_VERSION_MANIFEST_URL
    state.appHome = tempDir('hermes-runtime-version-home-')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllGlobals()
    vi.resetModules()
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records a writable destination without changing the running Runtime', async () => {
    const currentRuntime = join(state.appHome, 'desktop-runtime', 'hermes', '0.18.0', 'test-platform')
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    const destination = tempDir('hermes-runtime-version-destination-')
    mkdirSync(join(state.appHome, 'desktop-runtime'), { recursive: true })
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.18.0',
      runtimeDirectory: currentRuntime,
      platform: 'test-platform',
    }))

    const { scheduleRuntimeRootMigration } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const active = scheduleRuntimeRootMigration(destination)
    const persisted = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(active.runtimeDirectory).toBe(currentRuntime)
    expect(active.pendingRuntimeRootDirectory).toBe(resolve(destination))
    expect(persisted.pendingRuntimeRootDirectory).toBe(resolve(destination))
    expect(persisted.runtimeRootDirectory).toBeUndefined()
  })

  it('reports the installed Hermes Agent version separately from the Runtime package version', async () => {
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    mkdirSync(join(state.appHome, 'desktop-runtime'), { recursive: true })
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.1',
      runtimeDirectory: join(state.appHome, 'desktop-runtime', 'hermes', '0.19.1', 'test-platform'),
      platform: 'test-platform',
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema: 1,
        hermes: ['0.19.1', '0.20.4'],
        mobile: { version: '1.0.0', channels: {} },
      }),
    }))

    const { getRuntimeVersionStatus } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const status = await getRuntimeVersionStatus()

    expect(status.hermes.activeVersion).toBe('0.19.1')
    expect(status.hermes.agentVersion).toBe('v2026.8.1')
    expect(status.hermes.remoteVersions).toEqual(['0.19.1', '0.20.4'])
    expect(status.webui.remoteVersions).toEqual([])
    expect(fetch).toHaveBeenCalledWith(
      'https://api.hermes-studio.ai/api/studio/versions',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('can probe the desktop CLI before loading Runtime state', async () => {
    const platform = runtimePlatformKey()
    const runtime = join(state.appHome, 'desktop-runtime', 'hermes', '0.19.1', platform)
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    createRuntime(runtime, '0.19.1')
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.1',
      runtimeDirectory: runtime,
      platform,
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { getRuntimeVersionStatus } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const status = await getRuntimeVersionStatus({ probeRuntime: false })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(status.active).toBeNull()
    expect(status.activeVersionPath).toBe('')
    expect(status.hermes.activeVersion).toBe('')
    expect(status.hermes.activeDirectory).toBe('')
    expect(status.hermes.installed).toEqual([])
    expect(status.hermes.remoteVersions).toEqual([])
  })

  it('probes local Runtime storage without loading remote versions in Web UI mode', async () => {
    delete process.env.HERMES_DESKTOP
    const platform = runtimePlatformKey()
    const runtime = join(state.appHome, 'desktop-runtime', 'hermes', '0.19.1', platform)
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    createRuntime(runtime, '0.19.1')
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.1',
      runtimeDirectory: runtime,
      runtimeRootDirectory: join(state.appHome, 'desktop-runtime'),
      webUiVersion: '0.6.30',
      platform,
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { getRuntimeVersionStatus } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const status = await getRuntimeVersionStatus({ includeRemote: false })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(status.active).toMatchObject({ hermesRuntimeVersion: '0.19.1' })
    expect(status.activeVersionPath).toBe(activeVersionPath)
    expect(status.remoteManifestUrl).not.toBe('')
    expect(status.remoteError).toBe('')
    expect(status.hermes).toMatchObject({
      activeVersion: '0.19.1',
      agentVersion: 'v2026.8.1',
      activeDirectory: runtime,
      storageDirectory: join(state.appHome, 'desktop-runtime'),
      defaultStorageDirectory: join(state.appHome, 'desktop-runtime'),
      pendingStorageDirectory: '',
      migrationError: '',
      activationError: '',
      installed: [expect.objectContaining({ version: '0.19.1', active: true })],
      remoteVersions: [],
    })
    expect(status.webui).toMatchObject({
      currentVersion: '0.6.31',
      activeVersion: '0.6.30',
      installed: [],
      remoteVersions: [],
    })
  })

  it('falls back to the previous website manifest when the Studio version API is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ schema: 1, hermes: ['0.19.1', '0.20.0'] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { getRuntimeVersionStatus } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const status = await getRuntimeVersionStatus()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.hermes-studio.ai/api/studio/versions',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://hermes-studio.ai/versions.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(status.hermes.remoteVersions).toEqual(['0.19.1', '0.20.0'])
    expect(status.remoteError).toBe('')
  })

  it('reports both errors when the Studio API and website manifest are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(new Error('website unavailable')))

    const { getRuntimeVersionStatus } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const status = await getRuntimeVersionStatus()

    expect(status.hermes.remoteVersions).toEqual([])
    expect(status.remoteError).toContain('returned 503')
    expect(status.remoteError).toContain('fallback failed: website unavailable')
  })

  it('rejects a destination nested inside the current Runtime storage root', async () => {
    const nestedDestination = join(state.appHome, 'desktop-runtime', 'nested')
    mkdirSync(nestedDestination, { recursive: true })

    const { scheduleRuntimeRootMigration } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')

    expect(() => scheduleRuntimeRootMigration(nestedDestination))
      .toThrow('cannot be inside the current Runtime storage directory')
  })

  it('uses the desktop Runtime root for downloaded Web UI versions without scanning the legacy directory', async () => {
    const storageRoot = tempDir('hermes-runtime-version-storage-')
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    const webUiDirectory = join(storageRoot, 'webui', '0.6.31')
    const legacyWebUiDirectory = join(state.appHome, 'webui', '0.6.30')
    mkdirSync(webUiDirectory, { recursive: true })
    mkdirSync(legacyWebUiDirectory, { recursive: true })
    mkdirSync(join(state.appHome, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(webUiDirectory, 'package.json'), JSON.stringify({ version: '0.6.31' }))
    writeFileSync(join(legacyWebUiDirectory, 'package.json'), JSON.stringify({ version: '0.6.30' }))
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      desktopAppVersion: '0.6.30',
      runtimeRootDirectory: storageRoot,
      platform: 'test-platform',
    }))

    const {
      activateDownloadedWebUiVersion,
      listInstalledWebUiVersions,
    } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')

    expect(listInstalledWebUiVersions()).toEqual([{
      version: '0.6.31',
      directory: webUiDirectory,
      active: false,
    }])
    const activated = activateDownloadedWebUiVersion('0.6.31')
    expect(activated.desktopAppVersion).toBe('0.6.30')
    expect(activated.webUiVersion).toBe('0.6.31')
    expect(activated.webUiDirectory).toBeUndefined()
    expect(() => activateDownloadedWebUiVersion('0.6.30'))
      .toThrow('Downloaded Web UI version not found')
  })

  it('does not list or activate an incomplete Runtime directory', async () => {
    const platform = runtimePlatformKey()
    const runtimeRoot = join(state.appHome, 'desktop-runtime', 'hermes')
    const validRuntime = join(runtimeRoot, '0.19.0', platform)
    const incompleteRuntime = join(runtimeRoot, '0.20.0', platform)
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    createRuntime(validRuntime, '0.19.0')
    createRuntime(incompleteRuntime, '0.20.0', { missingNode: true })
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.0',
      runtimeDirectory: validRuntime,
      platform,
    }))

    const {
      activateInstalledRuntimeVersion,
      listInstalledRuntimeVersions,
    } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')

    expect(listInstalledRuntimeVersions().map(runtime => runtime.version)).toEqual(['0.19.0'])
    expect(() => activateInstalledRuntimeVersion('0.20.0'))
      .toThrow(/Runtime 0\.20\.0 cannot be activated:.*node/)
    expect(JSON.parse(readFileSync(activeVersionPath, 'utf-8')).runtimeDirectory).toBe(validRuntime)
  })

  it('clears the previous activation error after selecting a valid Runtime', async () => {
    const platform = runtimePlatformKey()
    const runtime = join(state.appHome, 'desktop-runtime', 'hermes', '0.20.0', platform)
    const activeVersionPath = join(state.appHome, 'desktop-runtime', 'active-version.json')
    createRuntime(runtime, '0.20.0')
    writeFileSync(activeVersionPath, JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.0',
      runtimeActivationError: 'previous Runtime failed',
      platform,
    }))

    const { activateInstalledRuntimeVersion } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')
    const active = activateInstalledRuntimeVersion('0.20.0')

    expect(active.runtimeDirectory).toBe(runtime)
    expect(active.runtimeActivationError).toBe('')
  })

  it('accepts hermes.exe after a Windows CLI update replaces hermes.cmd', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const platform = runtimePlatformKey()
    const runtime = join(state.appHome, 'desktop-runtime', 'hermes', '0.20.0', platform)
    createRuntime(runtime, '0.20.0')
    const scripts = join(runtime, 'python', 'venv', 'Scripts')
    rmSync(join(scripts, 'hermes.cmd'))
    writeFileSync(join(scripts, 'hermes.exe'), '')

    const {
      activateInstalledRuntimeVersion,
      listInstalledRuntimeVersions,
    } = await import('../../packages/server/src/modules/hermes/services/runtime/version-manager')

    expect(listInstalledRuntimeVersions().map(item => item.version)).toContain('0.20.0')
    expect(activateInstalledRuntimeVersion('0.20.0').runtimeDirectory).toBe(runtime)
  })

})
