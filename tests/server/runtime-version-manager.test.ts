import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ appHome: '' }))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    get appHome() {
      return state.appHome
    },
  },
}))

vi.mock('../../packages/server/src/services/system-info', () => ({
  getHermesWebUiVersion: () => '0.6.31',
}))

const originalEnv = { ...process.env }
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

describe('runtime version manager storage migration', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.HERMES_DESKTOP_RUNTIME_DIR
    state.appHome = tempDir('hermes-runtime-version-home-')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
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

    const { scheduleRuntimeRootMigration } = await import('../../packages/server/src/services/runtime-version-manager')
    const active = scheduleRuntimeRootMigration(destination)
    const persisted = JSON.parse(readFileSync(activeVersionPath, 'utf-8'))

    expect(active.runtimeDirectory).toBe(currentRuntime)
    expect(active.pendingRuntimeRootDirectory).toBe(resolve(destination))
    expect(persisted.pendingRuntimeRootDirectory).toBe(resolve(destination))
    expect(persisted.runtimeRootDirectory).toBeUndefined()
  })

  it('rejects a destination nested inside the current Runtime storage root', async () => {
    const nestedDestination = join(state.appHome, 'desktop-runtime', 'nested')
    mkdirSync(nestedDestination, { recursive: true })

    const { scheduleRuntimeRootMigration } = await import('../../packages/server/src/services/runtime-version-manager')

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
      runtimeRootDirectory: storageRoot,
      platform: 'test-platform',
    }))

    const {
      activateDownloadedWebUiVersion,
      listInstalledWebUiVersions,
    } = await import('../../packages/server/src/services/runtime-version-manager')

    expect(listInstalledWebUiVersions()).toEqual([{
      version: '0.6.31',
      directory: webUiDirectory,
      active: false,
    }])
    const activated = activateDownloadedWebUiVersion('0.6.31')
    expect(activated.webUiVersion).toBe('0.6.31')
    expect(activated.webUiDirectory).toBeUndefined()
    expect(() => activateDownloadedWebUiVersion('0.6.30'))
      .toThrow('Downloaded Web UI version not found')
  })
})
