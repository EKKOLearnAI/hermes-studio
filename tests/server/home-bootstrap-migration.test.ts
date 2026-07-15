import { describe, expect, it, vi } from 'vitest'
import { runLegacyHomeBootstrapMigration } from '../../packages/server/src/services/hermes/home/bootstrap-migration'

describe('home bootstrap migration', () => {
  it('does no work when no legacy database exists', () => {
    const sync = vi.fn()
    expect(runLegacyHomeBootstrapMigration({ listProfiles: () => [], sync })).toEqual({ status: 'not_found' })
    expect(sync).not.toHaveBeenCalled()
  })

  it('returns only bounded import telemetry after a successful migration', () => {
    const counts = { profiles: 1, layouts: 1, spaces: 2, objects: 1, inventory: 0,
      ledger: 0, devices: 0, bindings: 0, stateEvents: 0, placements: 0, skipped: 0 }
    const sync = vi.fn(() => ({ runId: 'import:1', status: 'completed' as const, fingerprint: 'a'.repeat(64),
      version: 'home-migration-v1', profiles: ['default'], counts,
      startedAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-01T00:00:01.000Z' }))
    expect(runLegacyHomeBootstrapMigration({ listProfiles: () => ['default'], sync }))
      .toEqual({ status: 'completed', profileCount: 1, counts })
    expect(sync).toHaveBeenCalledWith({ profiles: ['default'] })
  })

  it('isolates failures and strips paths or source material from the result', () => {
    const stable = runLegacyHomeBootstrapMigration({ listProfiles: () => ['default'],
      sync: (() => { throw new Error('HOME_MIGRATION_SOURCE_UNAVAILABLE') }) as never })
    expect(stable).toEqual({ status: 'failed', code: 'HOME_MIGRATION_SOURCE_UNAVAILABLE' })

    const unexpected = runLegacyHomeBootstrapMigration({ listProfiles: () => ['default'],
      sync: (() => { throw new Error('sqlite D:\\private token=do-not-log') }) as never })
    expect(unexpected).toEqual({ status: 'failed', code: 'HOME_MIGRATION_FAILED' })
    expect(JSON.stringify(unexpected)).not.toMatch(/private|token|sqlite/i)
  })
})
