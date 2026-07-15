import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLifeConstraintSnapshot,
  createLifeSourceAccount,
  planLifeLeisure,
  recordLifeCommitment,
  recordLifeOption,
  verifyLifePlanRevision,
  type LifeConstraintSnapshot,
  type LifeOption,
  type LifeOptionKind,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('deterministic life leisure planner', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-planner-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('scores, schedules, and hands off selected options deterministically', () => {
    seedOptionAccounts()
    const game = option('game', 'game-puzzle', { title: 'Puzzle game', categoryTags: ['puzzle'],
      durationMinutes: 60, cost: { currency: 'CNY', amountMinor: 500 } })
    const music = option('music', 'music-ambient', { title: 'Ambient music', categoryTags: ['ambient'],
      durationMinutes: 30, screenBased: false, cost: null })
    const travel = option('travel', 'travel-far', { title: 'Expensive day trip', categoryTags: ['travel'],
      durationMinutes: 120, screenBased: false, locationClass: 'local',
      cost: { currency: 'CNY', amountMinor: 2_000 } })
    const constraint = constraintSnapshot()
    const result = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW })
    expect(result.plan.sessions).toEqual([
      { optionId: game.id, startsAt: '2026-07-15T10:00:00.000Z', endsAt: '2026-07-15T11:00:00.000Z',
        cost: { currency: 'CNY', amountMinor: 500 },
        rationaleCodes: ['HEALTH_FIT', 'PREFERENCE_MATCH', 'SCHEDULE_FIT', 'VARIETY_BONUS', 'WITHIN_BUDGET'] },
      { optionId: music.id, startsAt: '2026-07-15T11:00:00.000Z', endsAt: '2026-07-15T11:30:00.000Z',
        cost: null, rationaleCodes: ['HEALTH_FIT', 'SCHEDULE_FIT', 'VARIETY_BONUS', 'WITHIN_BUDGET'] },
    ])
    const candidates = new Map(result.plan.candidates.map(candidate => [candidate.optionId, candidate]))
    expect(candidates.get(travel.id)).toMatchObject({ eligible: false, score: null,
      exclusionCodes: ['BUDGET_EXCEEDED'] })
    expect(result.plan).toMatchObject({ totalMinutes: 90, totalCost: { currency: 'CNY', amountMinor: 500 } })
    expect(result.handoffs).toMatchObject([
      { optionId: game.id, kind: 'commerce', targetCapabilityId: 'commerce.product.search' },
      { optionId: music.id, kind: 'android', targetCapabilityId: 'android.app.launch' },
    ])
    expect(planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW })).toEqual(result)
  })

  it('applies unknown-readiness, screen, category, budget, and travel-radius hard gates', () => {
    seedOptionAccounts()
    const short = option('game', 'short-safe', { durationMinutes: 20, screenBased: false, cost: null })
    const long = option('game', 'long-unknown', { durationMinutes: 60, screenBased: false, cost: null })
    const screen = option('game', 'screen-full', { durationMinutes: 20, screenBased: true, cost: null })
    const excluded = option('music', 'excluded-horror', { durationMinutes: 20, screenBased: false,
      categoryTags: ['horror'], cost: null })
    const expensive = option('music', 'expensive', { durationMinutes: 20, screenBased: false,
      cost: { currency: 'CNY', amountMinor: 2_000 } })
    const travel = option('travel', 'local-trip', { durationMinutes: 20, screenBased: false,
      locationClass: 'local', cost: null })
    const constraint = constraintSnapshot({ readiness: 'unknown', recovery: 'unknown', sleepDebt: 'unknown',
      screenTimeUsedMinutes: 120, screenTimeLimitMinutes: 120, budgetMinor: 1_000,
      excludedCategories: ['horror'], maxTravelRadiusKm: 0 })
    const plan = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW }).plan
    const candidates = new Map(plan.candidates.map(candidate => [candidate.optionId, candidate]))
    expect(plan.sessions).toHaveLength(1)
    expect(plan.sessions[0]?.optionId).toBe(short.id)
    expect(candidates.get(long.id)?.exclusionCodes).toContain('READINESS_UNKNOWN_SCOPE')
    expect(candidates.get(screen.id)?.exclusionCodes).toContain('SCREEN_TIME_LIMIT')
    expect(candidates.get(excluded.id)?.exclusionCodes).toContain('CATEGORY_EXCLUDED')
    expect(candidates.get(expensive.id)?.exclusionCodes).toContain('BUDGET_EXCEEDED')
    expect(candidates.get(travel.id)?.exclusionCodes).toContain('TRAVEL_RADIUS_EXCEEDED')
  })

  it('places sessions after wrapped quiet hours and uses normalized option ID as the final tie-breaker', () => {
    seedOptionAccounts()
    const first = option('music', 'equal-a', { durationMinutes: 120, screenBased: false, cost: null })
    const second = option('music', 'equal-b', { durationMinutes: 120, screenBased: false, cost: null,
      sourceDigest: 'b'.repeat(64) })
    const constraint = constraintSnapshot({ horizon: { startsAt: '2026-07-15T22:00:00.000Z',
      endsAt: '2026-07-16T10:00:00.000Z' }, quietStartMinute: 1_380, quietEndMinute: 420,
      leisureTimeLimitMinutes: 120 })
    const plan = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW, maxSessions: 1 }).plan
    expect(plan.sessions).toHaveLength(1)
    expect(plan.sessions[0]).toMatchObject({ optionId: [first.id, second.id].sort()[0],
      startsAt: '2026-07-16T07:00:00.000Z', endsAt: '2026-07-16T09:00:00.000Z' })
  })

  it('creates an Internet handoff for existing Bilibili options without owning playback', () => {
    const video = recordLifeOption({ accountId: null, kind: 'video', source: 'bilibili',
      providerItemId: 'BV1234567890', title: 'Documentary', categoryTags: ['video'], durationMinutes: 30,
      exertion: 'low', screenBased: true, locationClass: 'home', cost: null, available: true,
      observedAt: OBSERVED, expiresAt: EXPIRES, sourceDigest: 'c'.repeat(64) })
    const constraint = constraintSnapshot({ leisureTimeLimitMinutes: 30 })
    const result = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW })
    expect(result.plan.sessions[0]?.optionId).toBe(video.id)
    expect(result.handoffs).toMatchObject([{ optionId: video.id, kind: 'internet',
      targetCapabilityId: 'bilibili.video.search' }])
  })

  it('detects option and commitment material changes after a plan was frozen', () => {
    seedOptionAccounts()
    createLifeSourceAccount({ id: 'calendar-main', sourceKind: 'calendar', mode: 'observe', displayName: 'Calendar' })
    const originalCommitment = recordLifeCommitment({ accountId: 'calendar-main', providerItemId: 'event-001',
      label: 'Morning work', category: 'work', startsAt: '2026-07-15T08:00:00.000Z',
      endsAt: '2026-07-15T09:00:00.000Z', allDay: false, busy: true, locationClass: 'remote',
      participantAliasIds: [], observedAt: OBSERVED, expiresAt: EXPIRES, sourceDigest: 'd'.repeat(64) })
    const originalOption = option('game', 'changing-game', { durationMinutes: 30, screenBased: false, cost: null })
    const constraint = constraintSnapshot({ commitmentIds: [originalCommitment.id],
      factRefs: [{ recordId: originalCommitment.id, recordDigest: originalCommitment.sourceDigest,
        observedAt: originalCommitment.observedAt }] })
    const plan = planLifeLeisure({ constraintSnapshotId: constraint.id, activeAt: NOW }).plan
    expect(verifyLifePlanRevision({ planId: plan.id, activeAt: NOW })).toEqual({
      valid: true, reasonCodes: [], checkedAt: NOW,
    })
    option('game', 'changing-game', { durationMinutes: 30, screenBased: false, cost: null,
      title: 'Changed game', observedAt: '2026-07-15T09:30:00.000Z', sourceDigest: 'e'.repeat(64) })
    recordLifeCommitment({ accountId: 'calendar-main', providerItemId: 'event-001', label: 'Changed work',
      category: 'work', startsAt: '2026-07-15T08:00:00.000Z', endsAt: '2026-07-15T09:00:00.000Z',
      allDay: false, busy: true, locationClass: 'remote', participantAliasIds: [],
      observedAt: '2026-07-15T09:30:00.000Z', expiresAt: EXPIRES, sourceDigest: 'f'.repeat(64) })
    expect(verifyLifePlanRevision({ planId: plan.id, activeAt: NOW })).toMatchObject({ valid: false,
      reasonCodes: ['COMMITMENT_MATERIAL_CHANGED', 'OPTION_MATERIAL_CHANGED'] })
    expect(originalOption.id).toBe(plan.sessions[0]?.optionId)
  })
})

const OBSERVED = '2026-07-15T09:00:00.000Z'
const NOW = '2026-07-15T10:00:00.000Z'
const EXPIRES = '2026-07-16T10:00:00.000Z'

function seedOptionAccounts(): void {
  for (const sourceKind of ['travel', 'music', 'games'] as const) {
    createLifeSourceAccount({ id: `${sourceKind}-main`, sourceKind, mode: 'observe', displayName: sourceKind })
  }
}

function option(kind: Exclude<LifeOptionKind, 'video'>, providerItemId: string, override: Partial<{
  title: string; categoryTags: string[]; durationMinutes: number; screenBased: boolean
  locationClass: LifeOption['locationClass']; cost: LifeOption['cost']; observedAt: string; sourceDigest: string
}> = {}): LifeOption {
  const sourceKind = kind === 'game' ? 'games' : kind
  return recordLifeOption({ accountId: `${sourceKind}-main`, kind, source: `virtual-${sourceKind}`,
    providerItemId, title: override.title ?? providerItemId, categoryTags: override.categoryTags ?? [kind],
    durationMinutes: override.durationMinutes ?? 30, exertion: 'low', screenBased: override.screenBased ?? true,
    locationClass: override.locationClass ?? 'home', cost: override.cost === undefined
      ? { currency: 'CNY', amountMinor: 100 } : override.cost, available: true,
    observedAt: override.observedAt ?? OBSERVED, expiresAt: EXPIRES,
    sourceDigest: override.sourceDigest ?? hashChar(providerItemId).repeat(64) })
}

function constraintSnapshot(override: Partial<{
  horizon: { startsAt: string; endsAt: string }; readiness: LifeConstraintSnapshot['readiness']
  recovery: LifeConstraintSnapshot['recovery']; sleepDebt: LifeConstraintSnapshot['sleepDebt']
  screenTimeUsedMinutes: number; screenTimeLimitMinutes: number; leisureTimeLimitMinutes: number
  budgetMinor: number; quietStartMinute: number; quietEndMinute: number; maxTravelRadiusKm: number
  excludedCategories: string[]; preferredCategories: string[]; commitmentIds: string[]
  factRefs: LifeConstraintSnapshot['factRefs']
}> = {}): LifeConstraintSnapshot {
  const horizon = override.horizon ?? { startsAt: NOW, endsAt: '2026-07-15T14:00:00.000Z' }
  return createLifeConstraintSnapshot({ subjectId: 'person:self', horizon, timezone: 'UTC',
    freeWindows: [horizon], commitmentIds: override.commitmentIds ?? [], readiness: override.readiness ?? 'high',
    recovery: override.recovery ?? 'good', sleepDebt: override.sleepDebt ?? 'none',
    screenTimeUsedMinutes: override.screenTimeUsedMinutes ?? 0,
    screenTimeLimitMinutes: override.screenTimeLimitMinutes ?? 240,
    leisureTimeLimitMinutes: override.leisureTimeLimitMinutes ?? 180,
    budget: { currency: 'CNY', amountMinor: override.budgetMinor ?? 1_000 },
    quietStartMinute: override.quietStartMinute ?? 1_380, quietEndMinute: override.quietEndMinute ?? 420,
    maxTravelRadiusKm: override.maxTravelRadiusKm ?? 20, excludedCategories: override.excludedCategories ?? [],
    preferredCategories: override.preferredCategories ?? ['puzzle'], factRefs: override.factRefs ?? [],
    createdAt: NOW, expiresAt: EXPIRES })
}

function hashChar(value: string): string {
  const total = [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return (total % 10).toString()
}
