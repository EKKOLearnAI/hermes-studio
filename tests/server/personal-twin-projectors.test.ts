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
