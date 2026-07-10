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
    const second = twin.syncLegacyTwinSources()

    expect(second.counts).toEqual(first.counts)
    expect(twin.listTwinEntities({ type: 'person' })).toHaveLength(1)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' })).toHaveLength(2)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' })[0].provenance.source).toContain('health-state:')
    expect(twin.listTwinEvents({ eventType: 'fitness.workout.logged' })).toHaveLength(1)
    expect(twin.listTwinEvents({ eventType: 'personal.task.created' })).toHaveLength(1)
    expect(twin.listTwinEvents({ eventType: 'health.scale.measured' })).toHaveLength(2)
    expect(twin.listTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg' }).some(item => item.provenance.sourceId.includes(String(defaultScale.id)))).toBe(true)
  })
})
