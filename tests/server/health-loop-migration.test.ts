import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('health loop legacy migration', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-loop-migration-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('migrates all eight domains with stable provenance and preserves the source database', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-state')
    const migration = await import('../../packages/server/src/services/hermes/health-loop/migration')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    const times = {
      body: '2026-07-01T08:00:00+08:00', measurements: '2026-07-02T08:00:00+08:00',
      posture: '2026-07-03T08:00:00+08:00', skin: '2026-07-04T08:00:00+08:00',
      diet: '2026-07-05T12:00:00+08:00', fitness: '2026-07-06T18:00:00+08:00',
      sleep: '2026-07-07T07:00:00+08:00', internal: '2026-07-08T09:00:00+08:00',
    }
    const scale = health.createHealthScaleReading({ measuredAt: times.body, sourceDevice: 'S400', weightKg: 81.2, bodyFatPercent: 22 }, 'user', 'default')
    health.createHealthRecord({ id: 'measurements-1', kind: 'body_measurement', valueJson: { measurements: { waist_cm: 88, left_upper_arm_relaxed_cm: 34, right_upper_arm_relaxed_cm: 35 }, weightKg: 82, bodyFatPercent: 21 }, recordedAt: times.measurements, source: 'manual' }, 'user', 'default')
    health.createHealthRecord({ id: 'posture-1', kind: 'posture_assessment', valueJson: { issues: ['pelvic_rotation_right'], priority: 'high', pain: [{ area: 'right_neck_shoulder', score: null }], compensationChain: ['pelvis_right_rotation', 'lumbar_right_rotation'], modelVersion: 'vision-v1' }, recordedAt: times.posture, source: 'vision-model' }, 'user', 'default')
    health.createHealthRecord({ id: 'skin-1', kind: 'skin_assessment', valueJson: { concerns: ['acne', 'blackheads'], routine: { morning: ['cleanse', 'sunscreen'], evening: ['cleanse', 'moisturizer'] } }, recordedAt: times.skin, source: 'obsidian-import' }, 'user', 'default')
    health.createHealthFoodLog({ id: 'food-1', nutrition: { caloriesKcal: 650, proteinG: 38 }, loggedAt: times.diet }, 'user', 'default')
    health.createHealthWorkout({ id: 'workout-1', title: 'Strength', durationMinutes: 45, metrics: { rpe: 7, completed: true }, startedAt: times.fitness }, 'user', 'default')
    health.createHealthCheckIn({ id: 'sleep-1', checkinDate: '2026-07-07', sleep: { endedAt: times.sleep, durationMinutes: 450, subjectiveRecovery: 7 } }, 'user', 'default')
    health.createHealthRecord({ id: 'lab-1', kind: 'lab', title: 'Fasting glucose', valueJson: { marker: 'glucose', value: 5.2, unit: 'mmol/L', referenceLow: 3.9, referenceHigh: 6.1 }, unit: 'mmol/L', recordedAt: times.internal, source: 'hospital_report' }, 'user', 'default')

    const sourcePath = health.getHealthStateDbPath('default')
    const sourceHash = fileHash(sourcePath)
    const sourceCount = health.getHealthOverview({ profile: 'default', includeRecords: true }).records.length
    const result = migration.syncLegacyHealthTwinSources({ profiles: ['default'] })

    expect(result.status).toBe('completed')
    expect(result.version).toMatch(/^health-migration-v\d+$/)
    expect(result.domainCounts).toEqual({ body_composition: 2, measurements: 1, posture: 1, skin: 1, diet: 1, fitness: 1, sleep: 1, internal_health: 1 })
    expect(result.counts).toMatchObject({ read: 8, ingested: 9, replayed: 0, skipped: 0, conflicts: 0, errors: 0 })
    expect(result).not.toHaveProperty('sources')
    expect(fileHash(sourcePath)).toBe(sourceHash)
    expect(health.getHealthOverview({ profile: 'default', includeRecords: true }).records).toHaveLength(sourceCount)

    const events = twin.listTwinEvents({ eventType: 'health.ingestion.recorded', limit: 100 })
    expect(events).toHaveLength(9)
    expect(events.map(event => Date.parse(event.occurredAt))).toEqual(expect.arrayContaining(Object.values(times).map(value => Date.parse(value))))
    const scaleEvent = events.find(event => event.provenance.sourceId.startsWith(String(scale.id)))
    expect(scaleEvent?.provenance.evidence).toContainEqual(expect.objectContaining({ evidenceClass: 'measured' }))
    expect(events.find(event => event.payload.domain === 'posture')?.provenance.evidence).toContainEqual(expect.objectContaining({ evidenceClass: 'inferred' }))
    expect(events.find(event => event.payload.domain === 'skin')?.provenance.evidence).toContainEqual(expect.objectContaining({ evidenceClass: 'reported' }))
    expect(events.find(event => event.payload.domain === 'internal_health')).toMatchObject({
      provenance: { confirmationState: 'inferred', evidence: [expect.objectContaining({ evidenceClass: 'reported' })] },
      payload: { pendingConfirmation: true },
    })
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'health.measurements.waist_cm' })[0]?.value).toBe(88)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'health.body_composition.weight_kg' }).some(item => item.value === 82 && item.provenance.sourceId.includes('measurements-1:body-composition'))).toBe(true)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'health.posture.reported_pain' })[0]?.value).toEqual([{ area: 'right_neck_shoulder', score: null }])
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'health.skin.reported_concerns' })[0]?.value).toEqual(['acne', 'blackheads'])
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'health.internal_health.markers' })[0]?.value).toEqual([
      expect.objectContaining({ key: 'glucose', value: 5.2, unit: 'mmol/L', referenceInterval: { low: 3.9, high: 6.1 } }),
    ])
    expect(twin.listTwinObservations({ entityId: 'person:self', metricPrefixes: ['health.'], limit: 200 }).every(item => item.entityId === 'person:self')).toBe(true)
    expect(withPersonalTwinDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM twin_outbox').get() as { n: number }).n))).toBeGreaterThanOrEqual(8)
  })

  it('is a zero-write replay, imports only additions, and fails closed on changed source identity', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-state')
    const migration = await import('../../packages/server/src/services/hermes/health-loop/migration')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    health.createHealthRecord({ id: 'measurements-stable', kind: 'body_measurement', valueJson: { measurements: { waistCm: 88 } }, recordedAt: '2026-07-05T12:00:00+08:00', source: 'manual' }, 'user', 'default')

    const first = migration.syncLegacyHealthTwinSources({ profiles: ['default'] })
    const outboxAfterFirst = withPersonalTwinDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM twin_outbox').get() as { n: number }).n))
    const second = migration.syncLegacyHealthTwinSources({ profiles: ['default'] })
    expect(second).toEqual(first)
    expect(withPersonalTwinDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM twin_outbox').get() as { n: number }).n))).toBe(outboxAfterFirst)

    health.createHealthWorkout({ id: 'workout-new', title: 'Walk', durationMinutes: 30, startedAt: '2026-07-06T18:00:00+08:00' }, 'user', 'default')
    const incremental = migration.syncLegacyHealthTwinSources({ profiles: ['default'] })
    expect(incremental.counts).toMatchObject({ read: 2, ingested: 1, replayed: 1, conflicts: 0, errors: 0 })

    health.createHealthRecord({ id: 'measurements-stable', kind: 'body_measurement', valueJson: { measurements: { waistCm: 99 } }, recordedAt: '2026-07-05T12:00:00+08:00', source: 'manual' }, 'user', 'default')
    expect(() => migration.syncLegacyHealthTwinSources({ profiles: ['default'] })).toThrowError(/HEALTH_MIGRATION_SOURCE_CONFLICT/)
    const failed = withPersonalTwinDb(db => db.prepare("SELECT status, error FROM twin_import_runs WHERE source = 'legacy-health-state' ORDER BY started_at DESC, id DESC LIMIT 1").get() as { status: string; error: string })
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('HEALTH_MIGRATION_SOURCE_CONFLICT')
    expect(failed.error).not.toContain('measurements-stable')
    expect(failed.error).not.toContain(hermesHome)
  })

  it('treats missing and empty profiles as a completed no-op', async () => {
    const migration = await import('../../packages/server/src/services/hermes/health-loop/migration')
    const result = migration.syncLegacyHealthTwinSources({ profiles: ['missing-profile'] })
    expect(result.status).toBe('completed')
    expect(result.counts).toEqual({ read: 0, ingested: 0, replayed: 0, skipped: 0, conflicts: 0, errors: 0 })
    expect(result.domainCounts).toEqual({ body_composition: 0, measurements: 0, posture: 0, skin: 0, diet: 0, fitness: 0, sleep: 0, internal_health: 0 })
  })

  it('fails a corrupt logical record without leaking source contents and can import after correction', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-state')
    const migration = await import('../../packages/server/src/services/hermes/health-loop/migration')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin/database')
    health.createHealthRecord({ id: 'bad-measurement', kind: 'body_measurement', valueJson: { measurements: { waistCm: 9999 } }, recordedAt: '2026-07-05T12:00:00+08:00', source: 'manual-secret' }, 'user', 'default')

    expect(() => migration.syncLegacyHealthTwinSources({ profiles: ['default'] })).toThrowError('HEALTH_MIGRATION_INVALID_SOURCE')
    const failed = withPersonalTwinDb(db => db.prepare("SELECT status, error FROM twin_import_runs WHERE source = 'legacy-health-state' ORDER BY started_at DESC LIMIT 1").get() as { status: string; error: string })
    expect(failed).toEqual({ status: 'failed', error: 'HEALTH_MIGRATION_INVALID_SOURCE' })
    expect(JSON.stringify(failed)).not.toContain('9999')
    expect(JSON.stringify(failed)).not.toContain('manual-secret')
    expect(JSON.stringify(failed)).not.toContain(hermesHome)

    health.createHealthRecord({ id: 'bad-measurement', kind: 'body_measurement', valueJson: { measurements: { waistCm: 90 } }, recordedAt: '2026-07-05T12:00:00+08:00', source: 'manual-secret' }, 'user', 'default')
    const corrected = migration.syncLegacyHealthTwinSources({ profiles: ['default'] })
    expect(corrected.counts).toMatchObject({ read: 1, ingested: 1, errors: 0, conflicts: 0 })
  })
})
