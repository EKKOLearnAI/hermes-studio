import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_WINDOWS_DATA_MIGRATION_BACKUP,
  LEGACY_WINDOWS_DATA_MIGRATION_MARKER,
  LEGACY_WINDOWS_DATA_MIGRATION_STAGING,
  migratePendingLegacyWindowsData,
  type PendingLegacyWindowsDataMigrationOptions,
} from '../../packages/desktop/src/main/legacy-windows-data-migration'
import { decideLegacyWindowsDataMigration } from '../../packages/server/src/modules/hermes/services/profiles/legacy-windows-data-migration'

const roots: string[] = []

async function fixture(): Promise<{
  root: string
  userHome: string
  source: string
  target: string
  options: PendingLegacyWindowsDataMigrationOptions
}> {
  const root = await mkdtemp(join(tmpdir(), 'hermes-desktop-legacy-migration-'))
  roots.push(root)
  const userHome = join(root, 'user')
  const localAppData = join(root, 'local-app-data')
  const appData = join(root, 'roaming-app-data')
  const source = join(localAppData, 'hermes')
  const target = join(userHome, '.hermes')
  const options = {
    platform: 'win32' as const,
    env: { USERPROFILE: userHome, LOCALAPPDATA: localAppData, APPDATA: appData },
    userHome,
    hermesHome: target,
    now: () => new Date('2026-09-01T00:00:01.000Z'),
    isProcessAlive: () => false,
  }
  return { root, userHome, source, target, options }
}

async function scheduleMigration(state: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await decideLegacyWindowsDataMigration('migrate', {
    ...state.options,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop legacy Windows Hermes data migration', () => {
  it('merges through staging before startup and preserves target-only data', async () => {
    const state = await fixture()
    await mkdir(join(state.source, 'profiles', 'work'), { recursive: true })
    await mkdir(state.target, { recursive: true })
    await writeFile(join(state.source, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(state.source, 'gateway.lock'), '{"pid":99999}\n')
    await writeFile(join(state.source, 'profiles', 'work', '.env'), 'TOKEN=legacy\n')
    await writeFile(join(state.target, 'config.yaml'), 'model: current\n')
    await writeFile(join(state.target, 'current-only.txt'), 'keep\n')
    await scheduleMigration(state)

    const result = await migratePendingLegacyWindowsData(state.options)

    expect(result).toMatchObject({ attempted: true, completed: true, retryPending: false })
    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: legacy\n')
    expect(await readFile(join(state.target, 'profiles', 'work', '.env'), 'utf8')).toBe('TOKEN=legacy\n')
    expect(await readFile(join(state.target, 'current-only.txt'), 'utf8')).toBe('keep\n')
    await expect(readFile(join(state.target, 'gateway.lock'), 'utf8')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(state.target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), 'utf8')))
      .toMatchObject({ action: 'migrate', state: 'completed' })
    await expect(readFile(join(state.userHome, LEGACY_WINDOWS_DATA_MIGRATION_STAGING))).rejects.toThrow()
    await expect(readFile(join(state.userHome, LEGACY_WINDOWS_DATA_MIGRATION_BACKUP))).rejects.toThrow()
    expect(await readFile(join(state.source, 'config.yaml'), 'utf8')).toBe('model: legacy\n')
  })

  it('leaves the target intact and retries after a Windows rename lock', async () => {
    const state = await fixture()
    await mkdir(state.source, { recursive: true })
    await mkdir(state.target, { recursive: true })
    await writeFile(join(state.source, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(state.target, 'config.yaml'), 'model: current\n')
    await scheduleMigration(state)
    const renamePath = vi.fn(async () => { throw new Error('EPERM: file is in use') })

    const failed = await migratePendingLegacyWindowsData({ ...state.options, renamePath })

    expect(failed).toMatchObject({ attempted: true, completed: false, retryPending: true })
    expect(failed.error).toContain('EPERM')
    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: current\n')
    expect(JSON.parse(await readFile(join(state.target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), 'utf8')))
      .toMatchObject({ action: 'migrate', state: 'failed' })

    const retried = await migratePendingLegacyWindowsData(state.options)
    expect(retried).toMatchObject({ attempted: true, completed: true, retryPending: false })
    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: legacy\n')
  })

  it('retries instead of copying a source directory used by a live legacy gateway', async () => {
    const state = await fixture()
    await mkdir(state.source, { recursive: true })
    await mkdir(state.target, { recursive: true })
    await writeFile(join(state.source, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(state.source, 'gateway.lock'), '{"pid":4242}\n')
    await writeFile(join(state.target, 'config.yaml'), 'model: current\n')
    await scheduleMigration(state)

    const result = await migratePendingLegacyWindowsData({
      ...state.options,
      isProcessAlive: pid => pid === 4242,
    })

    expect(result).toMatchObject({ attempted: true, completed: false, retryPending: true })
    expect(result.error).toContain('PID: 4242')
    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: current\n')
  })

  it('recovers an interrupted directory switch before local services start', async () => {
    const state = await fixture()
    await mkdir(state.source, { recursive: true })
    await mkdir(state.target, { recursive: true })
    await writeFile(join(state.source, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(state.target, 'config.yaml'), 'model: current\n')
    await scheduleMigration(state)

    const pendingMarker = JSON.parse(await readFile(join(state.target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), 'utf8'))
    const staging = join(state.userHome, LEGACY_WINDOWS_DATA_MIGRATION_STAGING)
    const backup = join(state.userHome, LEGACY_WINDOWS_DATA_MIGRATION_BACKUP)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(staging, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), `${JSON.stringify({
      ...pendingMarker,
      state: 'completed',
      completedAt: '2026-09-01T00:00:01.000Z',
    })}\n`)
    await rename(state.target, backup)

    const recovered = await migratePendingLegacyWindowsData(state.options)
    expect(recovered).toMatchObject({ attempted: true, completed: true, retryPending: false })
    expect(resolve(state.target)).toBe(resolve(state.options.hermesHome!))
    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: legacy\n')
  })

  it('ignores declined and non-Windows markers', async () => {
    const state = await fixture()
    await mkdir(state.source, { recursive: true })
    await writeFile(join(state.source, 'config.yaml'), 'model: legacy\n')
    await decideLegacyWindowsDataMigration('decline', state.options)

    expect(await migratePendingLegacyWindowsData(state.options))
      .toMatchObject({ supported: true, attempted: false })
    expect(await migratePendingLegacyWindowsData({ ...state.options, platform: 'darwin' }))
      .toMatchObject({ supported: false, attempted: false })
  })
})
