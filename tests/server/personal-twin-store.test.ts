import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal twin store', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-twin-store-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('upserts entities and related records by provenance identity', async () => {
    const {
      TwinIdentityConflictError,
      TwinRecordNotFoundError,
      getTwinEntity,
      listTwinConstraints,
      listTwinEntities,
      listTwinGoals,
      listTwinRelations,
      upsertTwinConstraint,
      upsertTwinEntity,
      upsertTwinGoal,
      upsertTwinRelation,
    } = await import('../../packages/server/src/services/hermes/personal-twin')

    upsertTwinEntity({
      id: 'person:self', type: 'person', label: 'Self', attributes: { heightCm: 178 }, source: 'system', sourceId: 'self',
    })
    upsertTwinEntity({
      type: 'person', label: 'Li Hao', attributes: { heightCm: 179 }, source: 'system', sourceId: 'self',
    })
    upsertTwinEntity({ id: 'body:self', type: 'body', label: 'Body', source: 'system', sourceId: 'body:self' })

    upsertTwinRelation({ subjectId: 'body:self', predicate: 'belongs_to', objectId: 'person:self', source: 'system', sourceId: 'body-owner' })
    upsertTwinGoal({
      subjectId: 'person:self', domain: 'body', title: 'Reach target weight', target: { weightKg: 75 }, status: 'active', priority: 100,
      source: 'health-state:default', sourceId: 'goal:target-weight',
    })
    upsertTwinGoal({
      subjectId: 'person:self', domain: 'body', title: 'Reach target weight soon', target: { weightKg: 74 }, status: 'active', priority: 90,
      source: 'health-state:default', sourceId: 'goal:target-weight',
    })
    upsertTwinConstraint({
      subjectId: 'person:self', domain: 'health', key: 'allergy', value: 'sample-allergen', enforcement: 'hard',
      source: 'health-state:default', sourceId: 'allergy:sample-allergen',
    })

    expect(listTwinEntities({ type: 'person' })).toHaveLength(1)
    expect(getTwinEntity('person:self')).toMatchObject({ label: 'Li Hao', attributes: { heightCm: 179 } })
    expect(listTwinRelations({ subjectId: 'body:self' })).toEqual([
      expect.objectContaining({ predicate: 'belongs_to', objectId: 'person:self' }),
    ])
    expect(listTwinGoals({ subjectId: 'person:self' })).toEqual([
      expect.objectContaining({ title: 'Reach target weight soon', target: { weightKg: 74 } }),
    ])
    expect(listTwinConstraints({ subjectId: 'person:self' })).toEqual([
      expect.objectContaining({ key: 'allergy', enforcement: 'hard' }),
    ])
    expect(() => upsertTwinRelation({ subjectId: 'body:self', predicate: 'contains', objectId: 'missing', source: 'test', sourceId: 'missing-object' })).toThrow(TwinRecordNotFoundError)
    expect(() => upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Other', source: 'other-profile', sourceId: 'self' })).toThrow(TwinIdentityConflictError)
  })

  it('applies fixed filters and clamps list limits', async () => {
    const { listTwinEntities, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    for (let index = 0; index < 205; index += 1) {
      upsertTwinEntity({ type: index % 2 === 0 ? 'device' : 'room', label: `Record ${index}`, source: 'fixture', sourceId: `record-${index}` })
    }

    expect(listTwinEntities({ type: 'device', limit: 2 })).toHaveLength(2)
    expect(listTwinEntities({ type: 'device', limit: 0 })).toHaveLength(1)
    expect(listTwinEntities({ limit: 999 })).toHaveLength(200)
  })

  it('records observations and events idempotently with transactional outbox entries', async () => {
    const {
      listTwinEvents,
      listTwinObservations,
      recordTwinEvent,
      recordTwinObservation,
      TwinImmutableRecordConflictError,
      upsertTwinEntity,
      withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })

    const observation = {
      entityId: 'person:self', metric: 'body.weight_kg', value: 85, unit: 'kg', observedAt: '2026-07-08T08:41:00+08:00',
      source: 'health-state:default', sourceId: 'scale-reading-1', actor: 'scale-sync', confidence: 1,
      confirmationState: 'observed' as const, evidence: [],
    }
    recordTwinObservation(observation)
    recordTwinObservation(observation)
    recordTwinObservation({ ...observation, metric: 'body.bmi', value: 26.8 })
    recordTwinEvent({
      eventType: 'health.scale.measured', subjectId: 'person:self', payload: { sourceDevice: 'S400' }, occurredAt: observation.observedAt,
      source: observation.source, sourceId: observation.sourceId, actor: observation.actor, confidence: 1, confirmationState: 'observed', evidence: [],
    })
    recordTwinEvent({
      eventType: 'health.scale.measured', subjectId: 'person:self', payload: { sourceDevice: 'S400' }, occurredAt: observation.observedAt,
      source: observation.source, sourceId: observation.sourceId, actor: observation.actor, confidence: 1, confirmationState: 'observed', evidence: [],
    })

    expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(2)
    expect(listTwinEvents({ subjectId: 'person:self' })).toHaveLength(1)
    expect(withPersonalTwinDb(db => db.prepare('SELECT topic, aggregate_id, status FROM twin_outbox ORDER BY topic, aggregate_id').all())).toEqual([
      { topic: 'twin.event.recorded', aggregate_id: expect.any(String), status: 'pending' },
      { topic: 'twin.observation.recorded', aggregate_id: expect.any(String), status: 'pending' },
      { topic: 'twin.observation.recorded', aggregate_id: expect.any(String), status: 'pending' },
    ])
    expect(() => recordTwinObservation({ ...observation, value: 86 })).toThrow(TwinImmutableRecordConflictError)
    expect(() => recordTwinObservation({ ...observation, confidence: Number.NaN })).toThrow(/confidence/i)
    expect(() => recordTwinEvent({
      eventType: 'health.scale.measured', subjectId: 'person:self', payload: {}, occurredAt: observation.observedAt,
      source: 'health-state:default', sourceId: 'other', actor: 'scale-sync', confidence: 1.1, confirmationState: 'observed',
    })).toThrow(/confidence/i)
  })

  it('rolls back an observation when its outbox insert fails', async () => {
    const { listTwinObservations, recordTwinObservation, upsertTwinEntity, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    withPersonalTwinDb(db => db.exec(`
      CREATE TRIGGER fail_twin_observation_outbox
      BEFORE INSERT ON twin_outbox
      WHEN NEW.topic = 'twin.observation.recorded'
      BEGIN SELECT RAISE(ABORT, 'outbox failure'); END;
    `))
    expect(() => recordTwinObservation({
      entityId: 'person:self', metric: 'body.weight_kg', value: 85, unit: 'kg', observedAt: '2026-07-08T08:41:00+08:00',
      source: 'test', sourceId: 'rollback', actor: 'test', confidence: 1, confirmationState: 'observed', evidence: [],
    })).toThrow(/outbox failure/i)
    expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(0)
  })

  it('stores canonical preferences with provenance and idempotent outbox updates', async () => {
    const {
      getTwinPreference, setTwinPreference, upsertTwinEntity, withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })

    const input = {
      subjectId: 'person:self', domain: 'digital' as const, key: 'appearance.theme', value: { contrast: 1, mode: 'dark' },
      source: 'action-fabric', sourceId: 'intent-a/workflow-a/execution-a', actor: 'action-fabric', confidence: 1,
    }
    const first = setTwinPreference(input)
    const replay = setTwinPreference({ ...input, value: { mode: 'dark', contrast: 1 } })

    expect(replay).toEqual(first)
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')).toMatchObject({
      subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: { contrast: 1, mode: 'dark' },
      provenance: { source: 'action-fabric', sourceId: input.sourceId, actor: 'action-fabric', confidence: 1 },
    })
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) count FROM twin_outbox WHERE topic='twin.preference.set'").get()))
      .toEqual({ count: 1 })
  })

  it('exposes a migrated legacy preference and updates the original row with CAS semantics', async () => {
    const {
      getTwinPreference, setTwinPreference, twinPreferenceExpectation, upsertTwinEntity, withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    withPersonalTwinDb(db => {
      db.exec("DROP INDEX idx_twin_preferences_address; UPDATE twin_meta SET value='3' WHERE key='schema_version'")
      db.prepare(`INSERT INTO twin_preferences
        (id,subject_id,key,value_json,confidence,source,source_id,actor,version,created_at,updated_at)
        VALUES('legacy-preference','person:self','calendar.view','"agenda"',0.6,'legacy','legacy-source-id','importer',7,'created','updated')`).run()
    })

    const migrated = getTwinPreference('person:self', 'life', 'calendar.view')
    expect(migrated).toMatchObject({
      id: 'legacy-preference', subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'agenda',
      provenance: { source: 'legacy', sourceId: 'legacy-source-id', actor: 'importer', confidence: 0.6 },
      version: 7, createdAt: 'created', updatedAt: 'updated',
    })
    const updated = setTwinPreference({
      subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'week', source: 'action-fabric',
      sourceId: 'legacy-update', actor: 'assistant-role', operationId: 'legacy-update-op',
      expectedCurrent: twinPreferenceExpectation(migrated),
    })

    expect(updated).toMatchObject({ id: 'legacy-preference', value: 'week', version: 8 })
    expect(withPersonalTwinDb(db => db.prepare(
      "SELECT COUNT(*) count FROM twin_preferences WHERE subject_id='person:self' AND key='life:calendar.view'",
    ).get())).toEqual({ count: 1 })
    expect(() => setTwinPreference({
      subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'month', source: 'action-fabric',
      sourceId: 'legacy-stale', actor: 'assistant-role', operationId: 'legacy-stale-op',
      expectedCurrent: twinPreferenceExpectation(migrated),
    })).toThrow('TWIN_PREFERENCE_CONFLICT')
  })

  it('validates preference identity, domains, keys, values, and operation provenance', async () => {
    const { setTwinPreference, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const valid = { subjectId: 'person:self', domain: 'life' as const, key: 'schedule.week_start', value: 'monday',
      source: 'action-fabric', sourceId: 'intent/workflow/step', actor: 'action-fabric', confidence: 1 }
    expect(() => setTwinPreference({ ...valid, subjectId: 'person:missing' })).toThrow(/not found/i)
    expect(() => setTwinPreference({ ...valid, domain: 'secrets' as never })).toThrow(/domain/i)
    expect(() => setTwinPreference({ ...valid, key: '_system.admin' })).toThrow(/reserved/i)
    expect(() => setTwinPreference({ ...valid, key: 'x'.repeat(161) })).toThrow(/key/i)
    expect(() => setTwinPreference({ ...valid, value: 'x'.repeat(8_193) })).toThrow(/value/i)
    expect(() => setTwinPreference({ ...valid, value: { bad: Number.NaN } })).toThrow(/value/i)
    expect(() => setTwinPreference({ ...valid, source: '' })).toThrow(/source/i)
  })

  it('deletes preferences atomically and makes duplicate operation tokens harmless', async () => {
    const {
      deleteTwinPreference, getTwinPreference, setTwinPreference, upsertTwinEntity, withPersonalTwinDb,
    } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    setTwinPreference({ subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'calm',
      source: 'action-fabric', sourceId: 'set-token', actor: 'action-fabric', confidence: 1 })
    const operation = { source: 'action-fabric' as const, sourceId: 'delete-token', actor: 'action-fabric' }
    deleteTwinPreference('person:self', 'home', 'lighting.scene', operation)
    withPersonalTwinDb(db => db.prepare('DELETE FROM twin_outbox').run())
    deleteTwinPreference('person:self', 'home', 'lighting.scene', operation)
    expect(getTwinPreference('person:self', 'home', 'lighting.scene')).toBeNull()
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) count FROM twin_outbox WHERE topic='twin.preference.deleted'").get()))
      .toEqual({ count: 0 })
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) count FROM twin_preference_operations WHERE kind='delete'").get()))
      .toEqual({ count: 1 })

    setTwinPreference({ subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'focus',
      source: 'action-fabric', sourceId: 'newer-token', actor: 'action-fabric', confidence: 1 })
    expect(() => deleteTwinPreference('person:self', 'home', 'lighting.scene', operation))
      .toThrow('TWIN_PREFERENCE_OPERATION_STALE')
    expect(getTwinPreference('person:self', 'home', 'lighting.scene')?.value).toBe('focus')
  })

  it('rolls back preference mutations when their outbox insert fails', async () => {
    const { getTwinPreference, setTwinPreference, upsertTwinEntity, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    withPersonalTwinDb(db => db.exec(`CREATE TRIGGER fail_preference_outbox BEFORE INSERT ON twin_outbox
      WHEN NEW.topic='twin.preference.set' BEGIN SELECT RAISE(ABORT, 'preference outbox failure'); END`))
    expect(() => setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'dark',
      source: 'action-fabric', sourceId: 'rollback-token', actor: 'action-fabric', confidence: 1 })).toThrow(/outbox failure/i)
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')).toBeNull()
  })

  it('serializes concurrent preference writes and binds operation IDs to one material write', async () => {
    const { getTwinPreference, setTwinPreference, upsertTwinEntity, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const base = { subjectId: 'person:self', domain: 'digital' as const, key: 'appearance.theme',
      source: 'action-fabric', actor: 'action-fabric', confidence: 1 }
    await Promise.all(Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => setTwinPreference({
      ...base, value: `theme-${index}`, sourceId: `concurrent-${index}`,
    }))))
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')).not.toBeNull()
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) count FROM twin_outbox WHERE topic='twin.preference.set'").get()))
      .toEqual({ count: 8 })

    expect(() => setTwinPreference({ ...base, key: 'appearance.font', value: 'large',
      sourceId: 'different-provenance', operationId: 'concurrent-0' })).toThrow('TWIN_PREFERENCE_OPERATION_CONFLICT')
    expect(getTwinPreference('person:self', 'digital', 'appearance.font')).toBeNull()
  })

  it('uses a durable operation ledger when outbox publication rows are gone and rejects stale replay', async () => {
    const { getTwinPreference, setTwinPreference, twinPreferenceExpectation, upsertTwinEntity, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const base = { subjectId: 'person:self', domain: 'life' as const, key: 'calendar.view',
      source: 'action-fabric', actor: 'assistant-role', confidence: 0.8 }
    const firstInput = { ...base, value: 'agenda', sourceId: 'token-1', operationId: 'operation-1' }
    const first = setTwinPreference(firstInput)
    withPersonalTwinDb(db => db.prepare('DELETE FROM twin_outbox').run())
    expect(setTwinPreference(firstInput)).toEqual(first)
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) count FROM twin_preference_operations').get()))
      .toEqual({ count: 1 })
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) count FROM twin_outbox').get())).toEqual({ count: 0 })

    setTwinPreference({ ...base, value: 'week', sourceId: 'token-2', operationId: 'operation-2',
      expectedCurrent: twinPreferenceExpectation(first) })
    expect(() => setTwinPreference(firstInput)).toThrow('TWIN_PREFERENCE_OPERATION_STALE')
    expect(getTwinPreference('person:self', 'life', 'calendar.view')).toMatchObject({
      value: 'week', provenance: { actor: 'assistant-role' }, version: 2,
    })
    expect(() => setTwinPreference({ ...firstInput, value: 'month' })).toThrow('TWIN_PREFERENCE_OPERATION_CONFLICT')
  })

  it('compares exact preference state in the same transaction before set or delete', async () => {
    const { deleteTwinPreference, getTwinPreference, setTwinPreference, twinPreferenceExpectation, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const absent = { state: 'absent' as const }
    const first = setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'dark',
      source: 'action-fabric', sourceId: 'cas-1', actor: 'role-a', operationId: 'cas-op-1', expectedCurrent: absent })
    expect(() => setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'light',
      source: 'action-fabric', sourceId: 'cas-2', actor: 'role-b', operationId: 'cas-op-2', expectedCurrent: absent }))
      .toThrow('TWIN_PREFERENCE_CONFLICT')
    const expected = twinPreferenceExpectation(first)
    setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'light',
      source: 'action-fabric', sourceId: 'cas-3', actor: 'role-b', operationId: 'cas-op-3', expectedCurrent: expected })
    expect(() => deleteTwinPreference('person:self', 'digital', 'appearance.theme', {
      source: 'action-fabric', sourceId: 'delete-cas', actor: 'role-a', expectedCurrent: expected,
    })).toThrow('TWIN_PREFERENCE_CONFLICT')
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')?.value).toBe('light')
  })

  it('allows only one concurrent compare-and-set contender to win', async () => {
    const { getTwinPreference, setTwinPreference, twinPreferenceExpectation, upsertTwinEntity } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const initial = setTwinPreference({ subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'calm',
      source: 'action-fabric', sourceId: 'cas-seed', actor: 'seed', operationId: 'cas-seed-op' })
    const expectedCurrent = twinPreferenceExpectation(initial)
    const attempts = await Promise.allSettled(['focus', 'sleep'].map((value, index) => Promise.resolve().then(() => setTwinPreference({
      subjectId: 'person:self', domain: 'home' as const, key: 'lighting.scene', value,
      source: 'action-fabric', sourceId: `race-${index}`, actor: 'race', operationId: `race-op-${index}`, expectedCurrent,
    }))))
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(getTwinPreference('person:self', 'home', 'lighting.scene')?.version).toBe(2)
  })

  it('namespaces identical set and delete operation tokens by source even after outbox cleanup', async () => {
    const { deleteTwinPreference, getTwinPreference, setTwinPreference, upsertTwinEntity, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    const left = setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'agenda',
      source: 'source-a', sourceId: 'shared-set-source-id', actor: 'actor-a', operationId: 'shared-set-operation' })
    const right = setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'dark',
      source: 'source-b', sourceId: 'shared-set-source-id', actor: 'actor-b', operationId: 'shared-set-operation' })
    expect(left.provenance.source).toBe('source-a')
    expect(right.provenance.source).toBe('source-b')

    deleteTwinPreference('person:self', 'life', 'calendar.view', {
      source: 'source-a', sourceId: 'shared-delete-token', actor: 'actor-a',
    })
    deleteTwinPreference('person:self', 'digital', 'appearance.theme', {
      source: 'source-b', sourceId: 'shared-delete-token', actor: 'actor-b',
    })
    withPersonalTwinDb(db => db.prepare('DELETE FROM twin_outbox').run())
    deleteTwinPreference('person:self', 'life', 'calendar.view', {
      source: 'source-a', sourceId: 'shared-delete-token', actor: 'actor-a',
    })
    deleteTwinPreference('person:self', 'digital', 'appearance.theme', {
      source: 'source-b', sourceId: 'shared-delete-token', actor: 'actor-b',
    })
    expect(getTwinPreference('person:self', 'life', 'calendar.view')).toBeNull()
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')).toBeNull()
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) count FROM twin_preference_operations').get()))
      .toEqual({ count: 4 })
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) count FROM twin_outbox').get())).toEqual({ count: 0 })
  })
})
