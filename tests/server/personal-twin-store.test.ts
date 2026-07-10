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
})
