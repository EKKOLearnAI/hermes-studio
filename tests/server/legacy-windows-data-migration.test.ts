import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decideLegacyWindowsDataMigration,
  getLegacyWindowsDataMigrationStatus,
  LEGACY_WINDOWS_DATA_MIGRATION_MARKER,
  type LegacyWindowsDataMigrationOptions,
} from '../../packages/server/src/modules/hermes/services/profiles/legacy-windows-data-migration'

const roots: string[] = []

async function fixture(): Promise<{
  root: string
  target: string
  localLegacy: string
  roamingLegacy: string
  options: LegacyWindowsDataMigrationOptions
}> {
  const root = await mkdtemp(join(tmpdir(), 'hermes-legacy-windows-data-'))
  roots.push(root)
  const userHome = join(root, 'user')
  const target = join(userHome, '.hermes')
  const localAppData = join(root, 'local-app-data')
  const appData = join(root, 'roaming-app-data')
  return {
    root,
    target,
    localLegacy: join(localAppData, 'hermes'),
    roamingLegacy: join(appData, 'hermes'),
    options: {
      platform: 'win32',
      env: { USERPROFILE: userHome, LOCALAPPDATA: localAppData, APPDATA: appData },
      userHome,
      hermesHome: target,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('legacy Windows Hermes data migration', () => {
  it('only prompts on Windows when the active Hermes home is USERPROFILE/.hermes', async () => {
    const state = await fixture()
    await mkdir(state.localLegacy, { recursive: true })
    await writeFile(join(state.localLegacy, 'config.yaml'), 'model: legacy\n')

    const supported = await getLegacyWindowsDataMigrationStatus(state.options)
    expect(supported).toMatchObject({
      supported: true,
      shouldPrompt: true,
      sourceDirectory: state.localLegacy,
      targetDirectory: state.target,
    })

    const nonWindows = await getLegacyWindowsDataMigrationStatus({ ...state.options, platform: 'darwin' })
    expect(nonWindows).toMatchObject({ supported: false, shouldPrompt: false })

    const customHome = await getLegacyWindowsDataMigrationStatus({
      ...state.options,
      hermesHome: join(state.root, 'custom-hermes-home'),
    })
    expect(customHome).toMatchObject({ supported: false, shouldPrompt: false })
  })

  it('prefers LOCALAPPDATA and falls back to APPDATA when the local directory has no data', async () => {
    const state = await fixture()
    await mkdir(state.localLegacy, { recursive: true })
    await mkdir(state.roamingLegacy, { recursive: true })
    await writeFile(join(state.roamingLegacy, 'config.yaml'), 'source: roaming\n')

    const fallback = await getLegacyWindowsDataMigrationStatus(state.options)
    expect(fallback.sourceDirectory).toBe(state.roamingLegacy)

    await writeFile(join(state.localLegacy, 'config.yaml'), 'source: local\n')
    const preferred = await getLegacyWindowsDataMigrationStatus(state.options)
    expect(preferred.sourceDirectory).toBe(state.localLegacy)
  })

  it('ignores a legacy directory that only contains a Hermes runtime', async () => {
    const state = await fixture()
    await mkdir(join(state.localLegacy, 'hermes-agent', 'node_modules'), { recursive: true })
    await mkdir(state.roamingLegacy, { recursive: true })
    await writeFile(join(state.roamingLegacy, 'state.db'), 'legacy database\n')

    const status = await getLegacyWindowsDataMigrationStatus(state.options)
    expect(status).toMatchObject({ shouldPrompt: true, sourceDirectory: state.roamingLegacy })
  })

  it('records a declined decision in the target directory and never prompts again', async () => {
    const state = await fixture()
    await mkdir(state.localLegacy, { recursive: true })
    await writeFile(join(state.localLegacy, 'config.yaml'), 'model: legacy\n')

    const result = await decideLegacyWindowsDataMigration('decline', state.options)
    expect(result.shouldPrompt).toBe(false)
    expect(result.decision).toMatchObject({ action: 'decline', state: 'completed' })
    expect(JSON.parse(await readFile(join(state.target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), 'utf8')))
      .toMatchObject({ action: 'decline', state: 'completed' })

    expect((await getLegacyWindowsDataMigrationStatus(state.options)).shouldPrompt).toBe(false)
  })

  it('records an accepted migration as pending without copying live data', async () => {
    const state = await fixture()
    await mkdir(join(state.localLegacy, 'profiles', 'work'), { recursive: true })
    await mkdir(state.target, { recursive: true })
    await writeFile(join(state.localLegacy, 'config.yaml'), 'model: legacy\n')
    await writeFile(join(state.localLegacy, 'profiles', 'work', '.env'), 'TOKEN=legacy\n')
    await writeFile(join(state.target, 'config.yaml'), 'model: current\n')
    await writeFile(join(state.target, 'current-only.txt'), 'keep\n')

    const result = await decideLegacyWindowsDataMigration('migrate', state.options)

    expect(await readFile(join(state.target, 'config.yaml'), 'utf8')).toBe('model: current\n')
    expect(await readFile(join(state.target, 'current-only.txt'), 'utf8')).toBe('keep\n')
    expect(result.shouldPrompt).toBe(false)
    expect(result.decision).toMatchObject({ action: 'migrate', state: 'pending' })
    expect((await getLegacyWindowsDataMigrationStatus(state.options)).shouldPrompt).toBe(false)
  })
})
