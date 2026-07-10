import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal twin projectors and context', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-twin-projectors-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('keeps the newest observation when data arrives out of order and replay is deterministic', async () => {
    const { getTwinProjection, recordTwinObservation, rebuildTwinProjections, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    recordTwinObservation({ entityId: 'person:self', metric: 'body.weight_kg', value: 84.5, unit: 'kg', observedAt: '2026-07-09T08:00:00+08:00', source: 'test', sourceId: 'new', actor: 'test', confidence: 1, confirmationState: 'observed' })
    recordTwinObservation({ entityId: 'person:self', metric: 'body.weight_kg', value: 85, unit: 'kg', observedAt: '2026-07-08T08:00:00+08:00', source: 'test', sourceId: 'old', actor: 'test', confidence: 1, confirmationState: 'observed' })

    rebuildTwinProjections()
    const first = getTwinProjection('latest:body.weight_kg', 'person:self')
    rebuildTwinProjections()
    const second = getTwinProjection('latest:body.weight_kg', 'person:self')

    expect(first?.value).toMatchObject({ value: 84.5, unit: 'kg', observedAt: '2026-07-09T08:00:00+08:00' })
    expect(second).toEqual(first)
  })

  it('updates the latest projection in the observation transaction and rolls everything back when projection fails', async () => {
    const {
      getTwinProjection,
      listTwinObservations,
      recordTwinObservation,
      upsertTwinEntity,
      withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })

    const observation = recordTwinObservation({
      entityId: 'person:self', metric: 'body.weight_kg', value: 84.5, unit: 'kg', observedAt: '2026-07-09T08:00:00+08:00',
      source: 'test', sourceId: 'project-now', actor: 'test', confidence: 1, confirmationState: 'observed',
    })
    expect(getTwinProjection('latest:body.weight_kg', 'person:self')).toMatchObject({
      sourceRecordId: observation.id,
      value: { value: 84.5, unit: 'kg' },
    })

    withPersonalTwinDb(db => db.exec(`
      CREATE TRIGGER fail_twin_projection
      BEFORE INSERT ON twin_projections
      WHEN NEW.projection_key = 'latest:body.bmi'
      BEGIN SELECT RAISE(ABORT, 'projection failure'); END;
    `))
    expect(() => recordTwinObservation({
      entityId: 'person:self', metric: 'body.bmi', value: 26.8, observedAt: '2026-07-09T08:00:00+08:00',
      source: 'test', sourceId: 'projection-rollback', actor: 'test', confidence: 1, confirmationState: 'observed',
    })).toThrow(/projection failure/i)
    expect(listTwinObservations({ metric: 'body.bmi' })).toEqual([])
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) AS count FROM twin_outbox WHERE aggregate_id LIKE 'observation-%'").get())).toEqual({ count: 1 })
  })

  it('preserves canonical subject attributes while serving overview and context', async () => {
    const {
      getPersonalTwinContext,
      getPersonalTwinOverview,
      getTwinEntity,
      upsertTwinEntity,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({
      id: 'person:self', type: 'person', label: 'Li Hao', attributes: { displayName: 'Li Hao', heightCm: 178 },
      source: 'system', sourceId: 'self',
    })

    expect(getPersonalTwinOverview().subject).toMatchObject({ label: 'Li Hao', attributes: { displayName: 'Li Hao', heightCm: 178 } })
    expect(getPersonalTwinContext().subject).toMatchObject({ label: 'Li Hao', attributes: { displayName: 'Li Hao', heightCm: 178 } })
    expect(getTwinEntity('person:self')).toMatchObject({ label: 'Li Hao', attributes: { displayName: 'Li Hao', heightCm: 178 } })
  })

  it('rebuilds and filters records beyond the public 200-row list bound', async () => {
    const {
      getPersonalTwinContext,
      getTwinProjection,
      rebuildTwinProjections,
      recordTwinEvent,
      recordTwinObservation,
      upsertTwinEntity,
      withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    recordTwinObservation({
      entityId: 'person:self', metric: 'body.deep_match', value: 'needle%_literal', observedAt: '2020-01-01T00:00:00.000Z',
      source: 'test', sourceId: 'old-match', actor: 'test', confidence: 1, confirmationState: 'observed',
    })
    recordTwinEvent({
      eventType: 'health.deep_match', subjectId: 'person:self', payload: { value: 'needle%_literal' }, occurredAt: '2020-01-01T00:00:00.000Z',
      source: 'test', sourceId: 'old-event-match', actor: 'test', confidence: 1, confirmationState: 'observed',
    })
    for (let index = 0; index < 200; index += 1) {
      const timestamp = new Date(Date.UTC(2021, 0, 1, 0, 0, index)).toISOString()
      recordTwinObservation({
        entityId: 'person:self', metric: `digital.noise_${index}`, value: 'haystack', observedAt: timestamp,
        source: 'test', sourceId: `noise-${index}`, actor: 'test', confidence: 1, confirmationState: 'observed',
      })
      recordTwinEvent({
        eventType: `digital.noise_${index}`, subjectId: 'person:self', payload: { value: 'haystack' }, occurredAt: timestamp,
        source: 'test', sourceId: `noise-event-${index}`, actor: 'test', confidence: 1, confirmationState: 'observed',
      })
    }

    withPersonalTwinDb(db => db.exec('DELETE FROM twin_projections'))
    rebuildTwinProjections()
    expect(getTwinProjection('latest:body.deep_match', 'person:self')).not.toBeNull()

    const context = getPersonalTwinContext({ domains: ['body', 'health'], query: 'needle%_literal', limit: 5 })
    expect(context.observations).toEqual([expect.objectContaining({ metric: 'body.deep_match', value: 'needle%_literal' })])
    expect(context.events).toEqual([expect.objectContaining({ eventType: 'health.deep_match', payload: { value: 'needle%_literal' } })])
  }, 30_000)

  it('creates the canonical subject and returns bounded domain context', async () => {
    const {
      getPersonalTwinContext,
      getPersonalTwinOverview,
      recordTwinEvent,
      recordTwinObservation,
      upsertTwinEntity,
    } = await import('../../packages/server/src/services/hermes/personal-twin')

    expect(getPersonalTwinOverview().subject).toMatchObject({ id: 'person:self', type: 'person' })
    upsertTwinEntity({ id: 'body:self', type: 'body', label: 'Body', source: 'system', sourceId: 'body:self' })
    recordTwinObservation({ entityId: 'person:self', metric: 'body.weight_kg', value: 84, observedAt: '2026-07-09T08:00:00+08:00', source: 'test', sourceId: 'weight', actor: 'test', confidence: 1, confirmationState: 'observed' })
    recordTwinObservation({ entityId: 'person:self', metric: 'home.pm25', value: 12, observedAt: '2026-07-09T08:00:00+08:00', source: 'test', sourceId: 'pm25', actor: 'test', confidence: 1, confirmationState: 'observed' })
    recordTwinEvent({ eventType: 'health.scale.measured', subjectId: 'person:self', payload: { value: 84 }, occurredAt: '2026-07-09T08:00:00+08:00', source: 'test', sourceId: 'scale-event', actor: 'test', confidence: 1, confirmationState: 'observed' })
    recordTwinEvent({ eventType: 'home.device.updated', subjectId: 'body:self', payload: { device: 'purifier' }, occurredAt: '2026-07-09T08:00:00+08:00', source: 'test', sourceId: 'home-event', actor: 'test', confidence: 1, confirmationState: 'observed' })

    const context = getPersonalTwinContext({ domains: ['body', 'health'], limit: 1 })
    expect(context.observations).toHaveLength(1)
    expect(context.observations[0].metric).toBe('body.weight_kg')
    expect(context.events).toHaveLength(1)
    expect(context.events[0].eventType).toBe('health.scale.measured')
    expect(getPersonalTwinContext({ domains: ['home'] }).observations).toEqual([
      expect.objectContaining({ metric: 'home.pm25' }),
    ])
  })
})
