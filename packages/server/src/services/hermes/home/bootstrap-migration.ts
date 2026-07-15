import { listLegacyHomeProfiles, syncLegacyHomeTwinSources, type HomeMigrationCounts } from './migration'

export type HomeBootstrapMigrationResult =
  | { status: 'not_found' }
  | { status: 'completed'; profileCount: number; counts: HomeMigrationCounts }
  | { status: 'failed'; code: string }

export function runLegacyHomeBootstrapMigration(dependencies: {
  listProfiles?: typeof listLegacyHomeProfiles
  sync?: typeof syncLegacyHomeTwinSources
} = {}): HomeBootstrapMigrationResult {
  try {
    const profiles = (dependencies.listProfiles ?? listLegacyHomeProfiles)()
    if (profiles.length === 0) return { status: 'not_found' }
    const result = (dependencies.sync ?? syncLegacyHomeTwinSources)({ profiles })
    return { status: 'completed', profileCount: result.profiles.length, counts: result.counts }
  } catch (error) {
    const raw = error instanceof Error ? error.message : ''
    const code = /^HOME_MIGRATION_[A-Z_]+$/.test(raw) ? raw : 'HOME_MIGRATION_FAILED'
    return { status: 'failed', code }
  }
}
