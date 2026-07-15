import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildLifeConstraintSnapshot,
  createLifeSourceAccount,
  recordLifeCommitment,
  type LifeConstraintPolicy,
} from '../../packages/server/src/services/hermes/life-orchestration'
import {
  ensurePrimarySubject,
  recordTwinObservation,
  setTwinPreference,
  writeTwinProjection,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('life constraint snapshot builder', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-constraint-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('merges hard commitments, computes exact free windows, and replays frozen material', () => {
    createCalendar()
    commitment('event-001', '2026-07-15T09:00:00.000Z', '2026-07-15T11:00:00.000Z', true, '1')
    commitment('event-002', '2026-07-15T10:30:00.000Z', '2026-07-15T12:00:00.000Z', true, '2')
    commitment('event-003', '2026-07-15T13:00:00.000Z', '2026-07-15T13:30:00.000Z', false, '3')
    const snapshot = buildLifeConstraintSnapshot(baseInput())
    expect(snapshot.freeWindows).toEqual([
      { startsAt: '2026-07-15T08:00:00.000Z', endsAt: '2026-07-15T09:00:00.000Z' },
      { startsAt: '2026-07-15T12:00:00.000Z', endsAt: '2026-07-15T14:00:00.000Z' },
    ])
    expect(snapshot).toMatchObject({ readiness: 'unknown', recovery: 'unknown', sleepDebt: 'unknown',
      screenTimeUsedMinutes: 180, screenTimeLimitMinutes: 180, expiresAt: EXPIRES })
    expect(snapshot.commitmentIds).toHaveLength(3)
    expect(snapshot.factRefs).toHaveLength(4)
    expect(buildLifeConstraintSnapshot(baseInput())).toEqual(snapshot)
  })

  it('uses fresh health and screen facts and truncates validity to the earliest freshness deadline', () => {
    seedFreshTwinFacts()
    const snapshot = buildLifeConstraintSnapshot(baseInput())
    expect(snapshot).toMatchObject({ readiness: 'high', recovery: 'good', sleepDebt: 'none',
      screenTimeUsedMinutes: 42, expiresAt: '2026-07-16T09:00:00.000Z' })
    expect(snapshot.factRefs).toHaveLength(4)
    expect(snapshot.factRefs.map(item => item.recordId)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^twin-projection:/),
      expect.stringMatching(/^twin-observation:/),
      'policy:life-planning',
    ]))
  })

  it('maps stale or future health to unknown and stale screen usage to a fully consumed allowance', () => {
    ensurePrimarySubject()
    healthProjection('health.readiness_state', '2026-07-13T09:00:00.000Z', { status: 'ready', score: 99 })
    healthProjection('health.recovery_state', '2026-07-13T09:00:00.000Z', {
      current: { recovery_score: { value: 95 }, duration_minutes: { value: 500 } },
    })
    recordTwinObservation({ entityId: 'person:self', metric: 'digital.screen_time.used_minutes', value: 5,
      unit: 'min', observedAt: '2026-07-13T09:00:00.000Z', source: 'digital', sourceId: 'screen-stale',
      actor: 'system', confidence: 1, confirmationState: 'observed' })
    const snapshot = buildLifeConstraintSnapshot(baseInput())
    expect(snapshot).toMatchObject({ readiness: 'unknown', recovery: 'unknown', sleepDebt: 'unknown',
      screenTimeUsedMinutes: 180, expiresAt: EXPIRES })
    expect(snapshot.factRefs).toHaveLength(4)
  })

  it('freezes Twin category preferences with provenance and changes material when preference use changes', () => {
    ensurePrimarySubject()
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'preferred_categories',
      value: ['documentary', 'puzzle'], source: 'user', sourceId: 'preferred-categories-v1',
      actor: 'user:self' })
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'excluded_categories',
      value: ['horror'], source: 'user', sourceId: 'excluded-categories-v1', actor: 'user:self' })
    const preferred = buildLifeConstraintSnapshot(baseInput())
    expect(preferred.preferredCategories).toEqual(['documentary', 'puzzle'])
    expect(preferred.excludedCategories).toEqual(['horror'])
    expect(preferred.factRefs.filter(item => item.recordId.startsWith('twin-preference:'))).toHaveLength(2)
    const fallback = buildLifeConstraintSnapshot({ ...baseInput(), useTwinPreferences: false })
    expect(fallback.preferredCategories).toEqual(['puzzle'])
    expect(fallback.excludedCategories).toEqual([])
    expect(fallback.id).not.toBe(preferred.id)
  })

  it('fails closed when an overlapping commitment is stale or policy categories conflict', () => {
    const conflict = { ...policy(), excludedCategories: ['puzzle'] }
    expect(() => buildLifeConstraintSnapshot({ ...baseInput(), policy: conflict }))
      .toThrow('LIFE_CONSTRAINT_CATEGORY_CONFLICT')
    createCalendar()
    commitment('event-stale', '2026-07-15T09:00:00.000Z', '2026-07-15T10:00:00.000Z', true, '4',
      '2026-07-15T09:30:00.000Z')
    expect(() => buildLifeConstraintSnapshot(baseInput())).toThrow('LIFE_CONSTRAINT_COMMITMENT_STALE')
  })
})

const CREATED = '2026-07-15T10:00:00.000Z'
const EXPIRES = '2026-07-16T10:00:00.000Z'

function policy(): LifeConstraintPolicy {
  return { budget: { currency: 'CNY', amountMinor: 5_000 }, screenTimeLimitMinutes: 180,
    leisureTimeLimitMinutes: 120, quietStartMinute: 1_380, quietEndMinute: 420,
    maxTravelRadiusKm: 20, excludedCategories: [], preferredCategories: ['puzzle'] }
}

function baseInput() {
  return { horizon: { startsAt: '2026-07-15T08:00:00.000Z', endsAt: '2026-07-15T14:00:00.000Z' },
    timezone: 'Asia/Shanghai', policy: policy(), createdAt: CREATED, expiresAt: EXPIRES }
}

function createCalendar(): void {
  createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'observe', displayName: 'Calendar' })
}

function commitment(providerItemId: string, startsAt: string, endsAt: string, busy: boolean,
  digestChar: string, expiresAt = '2026-07-16T12:00:00.000Z'): void {
  recordLifeCommitment({ accountId: 'calendar-main', providerItemId, label: providerItemId, category: 'work',
    startsAt, endsAt, allDay: false, busy, locationClass: 'remote', participantAliasIds: [],
    observedAt: '2026-07-15T07:00:00.000Z', expiresAt, sourceDigest: digestChar.repeat(64) })
}

function seedFreshTwinFacts(): void {
  ensurePrimarySubject()
  healthProjection('health.readiness_state', '2026-07-15T09:00:00.000Z', { status: 'ready', score: 88 })
  healthProjection('health.recovery_state', '2026-07-15T09:00:00.000Z', {
    current: { recovery_score: { value: 91 }, duration_minutes: { value: 450 } },
  })
  recordTwinObservation({ entityId: 'person:self', metric: 'digital.screen_time.used_minutes', value: 42,
    unit: 'min', observedAt: '2026-07-15T09:00:00.000Z', source: 'digital', sourceId: 'screen-fresh',
    actor: 'system', confidence: 1, confirmationState: 'observed' })
}

function healthProjection(key: 'health.readiness_state' | 'health.recovery_state', computedAt: string,
  state: Record<string, unknown>): void {
  writeTwinProjection({ key, subjectId: 'person:self', value: { schemaVersion: 1, computedAt, state,
    freshness: { status: 'fresh' }, conflictCount: 0 }, sourceRecordId: `${key.replace('.', '-')}-source`,
  updatedAt: computedAt })
}
