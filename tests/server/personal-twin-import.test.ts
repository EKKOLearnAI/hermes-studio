import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('legacy personal twin import', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-twin-import-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('imports health and personal state idempotently into one global twin', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-state')
    const personal = await import('../../packages/server/src/services/hermes/personal-state')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')

    health.updateHealthProfile({ displayName: 'Li Hao', heightCm: 178, goals: ['fat loss'], allergies: ['peanut'] }, 'user', 'default')
    const defaultScale = health.createHealthScaleReading({ measuredAt: '2026-07-08T08:41:00+08:00', sourceDevice: 'S400', weightKg: 85, bmi: 26.8 }, 'user', 'default')
    health.createHealthWorkout({ id: 'workout-1', kind: 'strength', title: 'Back', startedAt: '2026-07-08T10:00:00+08:00' }, 'user', 'default')
    health.createHealthFoodLog({ id: 'food-log-1', meal: 'lunch', quantity: 1, unit: 'serving', nutrition: { protein: 30 }, loggedAt: '2026-07-08T12:00:00+08:00' }, 'user', 'default')
    health.createHealthCheckIn({ id: 'checkin-1', checkinDate: '2026-07-08', mood: 'good' }, 'user', 'default')

    health.updateHealthProfile({ displayName: 'Li Hao', heightCm: 178 }, 'user', 'coach')
    health.createHealthScaleReading({ measuredAt: '2026-07-09T08:41:00+08:00', sourceDevice: 'S400', weightKg: 84.5 }, 'user', 'coach')
    const proposal = personal.proposePersonalStateChange({
      title: 'Prepare training task', summary: 'Log today\'s training', proposedAction: { type: 'task.create', payload: { id: 'task-training', title: 'Log training', notes: 'Record the session' } }, profile: 'default',
    })
    personal.approvePersonalStateProposal(proposal.id, 'user', 'default')

    const first = twin.syncLegacyTwinSources()
    expect(twin.listTwinEvents({ eventType: 'personal.task.status_changed' })).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'open' }) }),
    ])

    personal.checkInPersonalStateTask('task-training', 'user', 'default')
    health.updateHealthProfile({ birthDate: '1990-01-02' }, 'user', 'default')
    health.createHealthScaleReading({ measuredAt: '2026-07-10T08:41:00+08:00', sourceDevice: 'S400', weightKg: 84 }, 'user', 'default')
    const second = twin.syncLegacyTwinSources()
    const third = twin.syncLegacyTwinSources()

    expect(second.runId).not.toBe(first.runId)
    expect(third).toEqual(second)
    expect(twin.listTwinEntities({ type: 'person' })).toHaveLength(1)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' })).toHaveLength(3)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' })[0].provenance.source).toContain('health-state:')
    expect(twin.listTwinEvents({ eventType: 'fitness.workout.logged' })).toHaveLength(1)
    expect(twin.listTwinEvents({ eventType: 'personal.task.created' })).toHaveLength(1)
    expect(twin.listTwinEvents({ eventType: 'personal.task.status_changed' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'open' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ status: 'done' }) }),
    ]))
    expect(twin.listTwinEvents({ eventType: 'personal.task.status_changed' })).toHaveLength(2)
    expect(twin.listTwinEvents({ eventType: 'health.scale.measured' })).toHaveLength(3)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' }).some(item => item.provenance.sourceId.includes(String(defaultScale.id)))).toBe(true)
  })

  it('merges stable health profile fields into the canonical person attributes', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-state')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')

    health.updateHealthProfile({
      displayName: 'Li Hao',
      birthDate: '1990-01-02',
      sex: 'male',
      heightCm: 178,
      activityLevel: 'active',
      weightKg: 85,
      weightTargetKg: 75,
    }, 'user', 'default')

    twin.syncLegacyTwinSources()

    expect(twin.getTwinEntity('person:self')).toMatchObject({
      attributes: {
        displayName: 'Li Hao',
        birthDate: '1990-01-02',
        sex: 'male',
        heightCm: 178,
        activityLevel: 'active',
      },
    })
    expect(twin.getTwinEntity('person:self')?.attributes).not.toHaveProperty('weightKg')
    expect(twin.getTwinEntity('person:self')?.attributes).not.toHaveProperty('weightTargetKg')

    twin.getPersonalTwinOverview()
    expect(twin.getTwinEntity('person:self')?.attributes).toMatchObject({ displayName: 'Li Hao', heightCm: 178 })
  })

  it('claims one import-run owner and keeps terminal state causal with sanitized errors', async () => {
    const legacy = await import('../../packages/server/src/services/hermes/personal-twin/legacy-import')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    const first = legacy.claimTwinImportRun({ source: 'test-import', fingerprint: 'a'.repeat(64), version: 'test-v1' })
    const second = legacy.claimTwinImportRun({ source: 'test-import', fingerprint: 'a'.repeat(64), version: 'test-v1' })
    expect(first.owner).toBe(true)
    expect(second).toEqual(expect.objectContaining({ owner: false, runId: first.runId, status: 'started' }))

    const completed = legacy.completeTwinImportRun(first, { read: 1, ingested: 1 })
    expect(completed.status).toBe('completed')
    expect(() => legacy.failTwinImportRun(first, 'unsafe C:\\private\\health.db marker=secret')).toThrowError(/TWIN_IMPORT_RUN_TERMINAL/)
    const stored = withPersonalTwinDb(db => db.prepare('SELECT status, error FROM twin_import_runs WHERE id = ?').get(first.runId) as { status: string; error: string | null })
    expect(stored).toEqual({ status: 'completed', error: null })

    const failedClaim = legacy.claimTwinImportRun({ source: 'test-import', fingerprint: 'b'.repeat(64), version: 'test-v1' })
    legacy.failTwinImportRun(failedClaim, 'HEALTH_MIGRATION_INVALID_SOURCE')
    const failed = withPersonalTwinDb(db => db.prepare('SELECT status, error FROM twin_import_runs WHERE id = ?').get(failedClaim.runId) as { status: string; error: string })
    expect(failed).toEqual({ status: 'failed', error: 'HEALTH_MIGRATION_INVALID_SOURCE' })
    const retry = legacy.claimTwinImportRun({ source: 'test-import', fingerprint: 'b'.repeat(64), version: 'test-v1' })
    expect(retry).toEqual(expect.objectContaining({ owner: true, runId: failedClaim.runId, status: 'started' }))
    legacy.failTwinImportRun(retry, 'HEALTH_MIGRATION_INVALID_SOURCE')
  })

  it('fails closed when persisted import-run state is corrupt', async () => {
    const legacy = await import('../../packages/server/src/services/hermes/personal-twin/legacy-import')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    const input = { source: 'test-corrupt', fingerprint: 'c'.repeat(64), version: 'test-v1' }
    const claim = legacy.claimTwinImportRun(input)
    withPersonalTwinDb(db => db.prepare("UPDATE twin_import_runs SET counts_json = '{\"version\":\"wrong\"}' WHERE id = ?").run(claim.runId))
    expect(() => legacy.claimTwinImportRun(input)).toThrowError('TWIN_IMPORT_RUN_CORRUPT')
  })

  it('leases import ownership with generation-bound takeover and renewal', async () => {
    const legacy = await import('../../packages/server/src/services/hermes/personal-twin/legacy-import')
    let now = '2026-07-14T00:00:00.000Z'
    const options = { clock: () => now, leaseDurationMs: 1_000 }
    const input = { source: 'lease-test', fingerprint: 'd'.repeat(64), version: 'test-v1' }
    const ownerA = legacy.claimTwinImportRun(input, options)
    expect(ownerA).toMatchObject({ owner: true, generation: 1, leaseExpiresAt: '2026-07-14T00:00:01.000Z', ownerToken: expect.any(String) })
    const activeObserver = legacy.claimTwinImportRun(input, options)
    expect(activeObserver).toMatchObject({ owner: false, generation: 1 })
    expect(activeObserver.ownerToken).toBeUndefined()

    now = '2026-07-14T00:00:02.000Z'
    const ownerB = legacy.claimTwinImportRun(input, options)
    expect(ownerB).toMatchObject({ owner: true, generation: 2, leaseExpiresAt: '2026-07-14T00:00:03.000Z' })
    expect(ownerB.ownerToken).not.toBe(ownerA.ownerToken)
    const concurrentLoser = legacy.claimTwinImportRun(input, options)
    expect(concurrentLoser).toMatchObject({ owner: false, generation: 2 })
    expect(concurrentLoser.ownerToken).toBeUndefined()
    for (const finish of [
      () => legacy.completeTwinImportRun(ownerA, { read: 1 }, options),
      () => legacy.failTwinImportRun(ownerA, 'TEST_FAILURE', {}, options),
    ]) expect(finish).toThrowError(/TWIN_IMPORT_RUN_(?:LEASE_LOST|NOT_OWNER)/)

    now = '2026-07-14T00:00:02.500Z'
    const renewed = legacy.renewTwinImportRun(ownerB, options)
    expect(renewed).toMatchObject({ owner: true, generation: 2, leaseExpiresAt: '2026-07-14T00:00:03.500Z' })
    now = '2026-07-14T00:00:03.100Z'
    expect(legacy.claimTwinImportRun(input, options)).toMatchObject({ owner: false, generation: 2 })
    legacy.failTwinImportRun(renewed, 'TEST_FAILURE', {}, options)
    const ownerC = legacy.claimTwinImportRun(input, options)
    expect(ownerC).toMatchObject({ owner: true, generation: 3 })
    expect(JSON.stringify(ownerC)).not.toContain(ownerB.ownerToken)
  })

  it('fails closed for invalid clocks, lease bounds, and damaged lifecycle envelopes without leaking ownership tokens', async () => {
    const legacy = await import('../../packages/server/src/services/hermes/personal-twin/legacy-import')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    const input = { source: 'lease-hardening', fingerprint: 'e'.repeat(64), version: 'test-v1' }
    expect(() => legacy.claimTwinImportRun(input, { clock: () => '2026-07-14T00:00:00Z' })).toThrowError('TWIN_IMPORT_RUN_CLOCK_INVALID')
    expect(() => legacy.claimTwinImportRun(input, { leaseDurationMs: 999 })).toThrowError('TWIN_IMPORT_RUN_LEASE_INVALID')
    expect(() => legacy.claimTwinImportRun(input, { leaseDurationMs: 300_001 })).toThrowError('TWIN_IMPORT_RUN_LEASE_INVALID')

    const owner = legacy.claimTwinImportRun(input, { clock: () => '2026-07-14T00:00:00.000Z', leaseDurationMs: 1_000 })
    withPersonalTwinDb(db => db.prepare(`UPDATE twin_import_runs SET counts_json = ? WHERE id = ?`).run(JSON.stringify({
      version: 'test-v1', lifecycle: { lifecycleVersion: 1, ownerToken: owner.ownerToken, generation: 0, leaseExpiresAt: '2026-07-14T00:00:01.000Z' },
    }), owner.runId))
    let failure = ''
    try { legacy.claimTwinImportRun(input, { clock: () => '2026-07-14T00:00:02.000Z', leaseDurationMs: 1_000 }) } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toBe('TWIN_IMPORT_RUN_CORRUPT')
    expect(failure).not.toContain(owner.ownerToken)
  })
})
