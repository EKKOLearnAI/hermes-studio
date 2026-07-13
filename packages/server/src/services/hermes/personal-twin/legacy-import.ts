import { createHash, randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { getHealthOverview, getHealthStateDbPath, type HealthProfile } from '../health-state'
import { getPersonalStateDbPath, getPersonalStateOverview } from '../personal-state'
import { getHermesBaseDir, listProfileNamesFromDisk } from '../hermes-profile'
import { withPersonalTwinDb } from './database'
import {
  TwinLegacyImportResult, TwinEntity, TwinEventInput, TwinObservationInput,
} from './types'
import { ensurePrimarySubject } from './service'
import { recordTwinEvent, recordTwinObservation, upsertTwinConstraint, upsertTwinEntity, upsertTwinGoal } from './store'

const IMPORTER_VERSION = 1

export interface TwinImportRunClaim {
  runId: string
  source: string
  fingerprint: string
  version: string
  owner: boolean
  status: 'started' | 'completed' | 'failed'
  counts: Record<string, number>
  startedAt: string
  completedAt?: string
  generation?: number
  ownerToken?: string
  leaseExpiresAt?: string
}

export interface TwinImportRunLeaseOptions {
  clock?: () => string
  leaseDurationMs?: number
}

const IMPORT_SOURCE = /^[a-z][a-z0-9._-]{0,63}$/
const IMPORT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IMPORT_FINGERPRINT = /^[a-f0-9]{64}$/
const OWNER_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const LIFECYCLE_VERSION = 1
const DEFAULT_LEASE_MS = 60_000
const MIN_LEASE_MS = 1_000
const MAX_LEASE_MS = 300_000

interface StartedLifecycle {
  lifecycleVersion: 1
  ownerToken: string
  generation: number
  leaseExpiresAt: string
}

interface TerminalLifecycle {
  lifecycleVersion: 1
  generation: number
}

function canonicalTime(value: string): boolean {
  try { return new Date(value).toISOString() === value } catch { return false }
}

function leaseSettings(options: TwinImportRunLeaseOptions = {}): { now: string; durationMs: number; expiresAt: string } {
  let now: string
  try { now = options.clock ? options.clock() : new Date().toISOString() } catch { throw new Error('TWIN_IMPORT_RUN_CLOCK_INVALID') }
  if (!canonicalTime(now)) throw new Error('TWIN_IMPORT_RUN_CLOCK_INVALID')
  const durationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_LEASE_MS || durationMs > MAX_LEASE_MS) throw new Error('TWIN_IMPORT_RUN_LEASE_INVALID')
  const expiresAt = new Date(Date.parse(now) + durationMs).toISOString()
  if (!canonicalTime(expiresAt) || expiresAt <= now) throw new Error('TWIN_IMPORT_RUN_CLOCK_INVALID')
  return { now, durationMs, expiresAt }
}

function parseCountsEnvelope(value: unknown): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(String(value)) } catch { throw new Error('TWIN_IMPORT_RUN_CORRUPT') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  return parsed as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort())
}

function positiveGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseStartedLifecycle(value: unknown): StartedLifecycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  const lifecycle = value as Record<string, unknown>
  if (!exactKeys(lifecycle, ['lifecycleVersion', 'ownerToken', 'generation', 'leaseExpiresAt'])
    || lifecycle.lifecycleVersion !== LIFECYCLE_VERSION || typeof lifecycle.ownerToken !== 'string' || !OWNER_TOKEN.test(lifecycle.ownerToken)
    || !positiveGeneration(lifecycle.generation) || typeof lifecycle.leaseExpiresAt !== 'string' || !canonicalTime(lifecycle.leaseExpiresAt)) {
    throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  }
  return lifecycle as unknown as StartedLifecycle
}

function parseTerminalLifecycle(value: unknown): TerminalLifecycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  const lifecycle = value as Record<string, unknown>
  if (!exactKeys(lifecycle, ['lifecycleVersion', 'generation']) || lifecycle.lifecycleVersion !== LIFECYCLE_VERSION || !positiveGeneration(lifecycle.generation)) {
    throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  }
  return lifecycle as unknown as TerminalLifecycle
}

function parseImportCounts(value: unknown): Record<string, number> {
  const record = parseCountsEnvelope(value)
  const counts: Record<string, number> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === 'version' || key === 'lifecycle') continue
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(key) || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
    counts[key] = item
  }
  return counts
}

function validateImportCounts(counts: Record<string, number>): Record<string, number> {
  for (const [key, value] of Object.entries(counts)) {
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  }
  return { ...counts }
}

function importClaimFromRow(row: Record<string, unknown>, input: { source: string; fingerprint: string; version: string }, owner: boolean): TwinImportRunClaim {
  const status = String(row.status)
  if (!['started', 'completed', 'failed'].includes(status) || String(row.source) !== input.source || String(row.source_fingerprint) !== input.fingerprint) {
    throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  }
  const stored = parseCountsEnvelope(row.counts_json)
  if (stored.version !== input.version) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  const startedAt = String(row.started_at)
  const completedAt = row.completed_at === null || row.completed_at === undefined ? undefined : String(row.completed_at)
  const error = row.error === null || row.error === undefined ? undefined : String(row.error)
  if (!canonicalTime(startedAt) || (completedAt && (!canonicalTime(completedAt) || completedAt < startedAt))
    || (status === 'started' && (completedAt || error)) || (status === 'completed' && (!completedAt || error))
    || (status === 'failed' && (!completedAt || !error || !/^[A-Z][A-Z0-9_]{2,80}$/.test(error)))) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  const lifecycle = status === 'started' ? parseStartedLifecycle(stored.lifecycle)
    : status === 'failed' ? parseTerminalLifecycle(stored.lifecycle) : undefined
  if (status === 'started' && !exactKeys(stored, ['version', 'lifecycle'])) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  if (status === 'started' && (lifecycle as StartedLifecycle).leaseExpiresAt <= startedAt) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  if (status === 'completed' && stored.lifecycle !== undefined) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  return {
    runId: String(row.id), source: input.source, fingerprint: input.fingerprint, version: input.version,
    owner, status: status as TwinImportRunClaim['status'], counts: parseImportCounts(row.counts_json), startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(lifecycle ? { generation: lifecycle.generation } : {}),
    ...(status === 'started' ? { leaseExpiresAt: (lifecycle as StartedLifecycle).leaseExpiresAt } : {}),
    ...(owner && status === 'started' ? { ownerToken: (lifecycle as StartedLifecycle).ownerToken } : {}),
  }
}

function startedEnvelope(version: string, generation: number, expiresAt: string): { json: string; lifecycle: StartedLifecycle } {
  const lifecycle: StartedLifecycle = { lifecycleVersion: LIFECYCLE_VERSION, ownerToken: randomUUID(), generation, leaseExpiresAt: expiresAt }
  return { lifecycle, json: JSON.stringify({ version, lifecycle }) }
}

/** Atomically claims a deterministic import run, taking over only after its lease expires. */
export function claimTwinImportRun(input: { source: string; fingerprint: string; version: string }, options: TwinImportRunLeaseOptions = {}): TwinImportRunClaim {
  if (!IMPORT_SOURCE.test(input.source) || !IMPORT_FINGERPRINT.test(input.fingerprint) || !IMPORT_VERSION.test(input.version)) throw new Error('TWIN_IMPORT_RUN_INVALID')
  const runId = `import-${createHash('sha256').update(`${input.source}\0${input.fingerprint}`).digest('hex').slice(0, 32)}`
  const lease = leaseSettings(options)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT * FROM twin_import_runs WHERE source = ? AND source_fingerprint = ?').get(input.source, input.fingerprint) as Record<string, unknown> | undefined
      if (existing) {
        const prior = importClaimFromRow(existing, input, false)
        if (lease.now < prior.startedAt) throw new Error('TWIN_IMPORT_RUN_CLOCK_INVALID')
        const shouldTakeOver = prior.status === 'failed' || (prior.status === 'started' && prior.leaseExpiresAt! <= lease.now)
        if (shouldTakeOver) {
          const next = startedEnvelope(input.version, prior.generation! + 1, lease.expiresAt)
          const updated = db.prepare(`UPDATE twin_import_runs SET status = 'started', counts_json = ?, error = NULL, started_at = ?, completed_at = NULL
            WHERE id = ? AND status = ? AND counts_json = ?`)
            .run(next.json, lease.now, prior.runId, prior.status, String(existing.counts_json))
          if (Number(updated.changes) !== 1) throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
          const retried = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(prior.runId) as Record<string, unknown>
          const result = importClaimFromRow(retried, input, true)
          db.exec('COMMIT')
          return result
        }
        const result = prior
        db.exec('COMMIT')
        return result
      }
      const first = startedEnvelope(input.version, 1, lease.expiresAt)
      db.prepare(`INSERT INTO twin_import_runs (id, source, source_fingerprint, status, counts_json, started_at)
        VALUES (?, ?, ?, 'started', ?, ?)`).run(runId, input.source, input.fingerprint, first.json, lease.now)
      const row = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(runId) as Record<string, unknown>
      const result = importClaimFromRow(row, input, true)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  })
}

function ownedStartedRow(row: Record<string, unknown> | undefined, claim: TwinImportRunClaim, now: string): { lifecycle: StartedLifecycle; countsJson: string } {
  if (!row || String(row.id) !== claim.runId || String(row.source) !== claim.source || String(row.source_fingerprint) !== claim.fingerprint) {
    throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
  }
  if (String(row.status) !== 'started') throw new Error('TWIN_IMPORT_RUN_TERMINAL')
  const stored = parseCountsEnvelope(row.counts_json)
  if (stored.version !== claim.version) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  const lifecycle = parseStartedLifecycle(stored.lifecycle)
  const startedAt = String(row.started_at)
  if (!canonicalTime(startedAt) || lifecycle.leaseExpiresAt <= startedAt) throw new Error('TWIN_IMPORT_RUN_CORRUPT')
  if (now < startedAt) throw new Error('TWIN_IMPORT_RUN_CLOCK_INVALID')
  if (!claim.owner || !claim.ownerToken || !claim.generation || lifecycle.ownerToken !== claim.ownerToken || lifecycle.generation !== claim.generation || lifecycle.leaseExpiresAt <= now) {
    throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
  }
  return { lifecycle, countsJson: String(row.counts_json) }
}

export function renewTwinImportRun(claim: TwinImportRunClaim, options: TwinImportRunLeaseOptions = {}): TwinImportRunClaim {
  const lease = leaseSettings(options)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown> | undefined
      const owned = ownedStartedRow(row, claim, lease.now)
      const lifecycle: StartedLifecycle = { ...owned.lifecycle, leaseExpiresAt: lease.expiresAt }
      const result = db.prepare(`UPDATE twin_import_runs SET counts_json = ? WHERE id = ? AND status = 'started' AND counts_json = ?`)
        .run(JSON.stringify({ version: claim.version, lifecycle }), claim.runId, owned.countsJson)
      if (Number(result.changes) !== 1) throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
      const updated = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown>
      const renewed = importClaimFromRow(updated, claim, true)
      db.exec('COMMIT')
      return renewed
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  })
}

export function completeTwinImportRun(claim: TwinImportRunClaim, counts: Record<string, number>, options: TwinImportRunLeaseOptions = {}): TwinImportRunClaim {
  const validatedCounts = validateImportCounts(counts)
  const lease = leaseSettings(options)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown> | undefined
      const owned = ownedStartedRow(row, claim, lease.now)
      const result = db.prepare(`UPDATE twin_import_runs SET status = 'completed', counts_json = ?, error = NULL, completed_at = ?
        WHERE id = ? AND status = 'started' AND counts_json = ?`)
        .run(JSON.stringify({ version: claim.version, ...validatedCounts }), lease.now, claim.runId, owned.countsJson)
      if (Number(result.changes) !== 1) throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
      const updated = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown>
      const completed = importClaimFromRow(updated, claim, true)
      db.exec('COMMIT')
      return completed
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  })
}

export function failTwinImportRun(claim: TwinImportRunClaim, errorCode: string, counts: Record<string, number> = {}, options: TwinImportRunLeaseOptions = {}): TwinImportRunClaim {
  const validatedCounts = validateImportCounts(counts)
  const sanitized = /^[A-Z][A-Z0-9_]{2,80}$/.test(errorCode) ? errorCode : 'TWIN_IMPORT_FAILED'
  const lease = leaseSettings(options)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown> | undefined
      const owned = ownedStartedRow(row, claim, lease.now)
      const lifecycle: TerminalLifecycle = { lifecycleVersion: LIFECYCLE_VERSION, generation: owned.lifecycle.generation }
      const result = db.prepare(`UPDATE twin_import_runs SET status = 'failed', counts_json = ?, error = ?, completed_at = ?
        WHERE id = ? AND status = 'started' AND counts_json = ?`)
        .run(JSON.stringify({ version: claim.version, lifecycle, ...validatedCounts }), sanitized, lease.now, claim.runId, owned.countsJson)
      if (Number(result.changes) !== 1) throw new Error('TWIN_IMPORT_RUN_LEASE_LOST')
      const updated = db.prepare('SELECT * FROM twin_import_runs WHERE id = ?').get(claim.runId) as Record<string, unknown>
      const failed = importClaimFromRow(updated, claim, true)
      db.exec('COMMIT')
      return failed
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  })
}

function nowIso(): string { return new Date().toISOString() }
function stableId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }
function legacySource(profile: string, collection: string, id: unknown): string { return `health-state:${profile}:${collection}:${String(id)}` }
function personalSource(profile: string, collection: string, id: unknown): string { return `personal-state:${profile}:${collection}:${String(id)}` }
function numericEntries(value: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(value).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : [])
}
function stableHealthProfileAttributes(profile: HealthProfile): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    displayName: profile.displayName,
    birthDate: profile.birthDate,
    sex: profile.sex,
    heightCm: profile.heightCm,
    activityLevel: profile.activityLevel,
  }).filter(([, value]) => value !== null))
}
function legacyTimestamp(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  throw new Error(`Legacy record ${String(record.id || 'unknown')} has no stable timestamp`)
}
function profileStats(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, exists: false }
  const stats = statSync(path)
  return { path, exists: true, size: stats.size, mtimeMs: stats.mtimeMs }
}
function normalizeProfiles(profiles?: string[]): string[] {
  const known = new Set(listProfileNamesFromDisk())
  if (!profiles || profiles.length === 0) return [...known].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))
  return [...new Set(profiles.map(profile => profile.trim()).filter(profile => known.has(profile)))].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))
}
function fingerprint(profiles: string[]): string {
  const sources = profiles.flatMap(profile => [profileStats(getHealthStateDbPath(profile)), profileStats(getPersonalStateDbPath(profile))])
  return stableId(JSON.stringify({ importerVersion: IMPORTER_VERSION, profiles, sources }))
}
function observation(input: Omit<TwinObservationInput, 'actor' | 'confidence' | 'confirmationState'>): void {
  recordTwinObservation({ ...input, actor: 'legacy-import', confidence: 1, confirmationState: 'reported' })
}
function event(input: Omit<TwinEventInput, 'actor' | 'confidence' | 'confirmationState'>): void {
  recordTwinEvent({ ...input, actor: 'legacy-import', confidence: 1, confirmationState: 'reported' })
}

export function syncLegacyTwinSources(options: { profiles?: string[] } = {}): TwinLegacyImportResult {
  const profiles = normalizeProfiles(options.profiles)
  const sourceFingerprint = fingerprint(profiles)
  const existing = withPersonalTwinDb(db => db.prepare('SELECT * FROM twin_import_runs WHERE source = ? AND source_fingerprint = ? AND status = ?').get('legacy-personal-os', sourceFingerprint, 'completed') as Record<string, unknown> | undefined)
  if (existing) return {
    runId: String(existing.id), profiles, status: 'completed', counts: JSON.parse(String(existing.counts_json)),
    startedAt: String(existing.started_at), completedAt: String(existing.completed_at),
  }

  const runId = `legacy-import-${sourceFingerprint}`
  const startedAt = nowIso()
  const counts = { entities: 0, observations: 0, events: 0, goals: 0, constraints: 0 }
  try {
    let subject = ensurePrimarySubject(); counts.entities += 1
    const body: TwinEntity = upsertTwinEntity({ id: 'body:self', type: 'body', label: 'Body', source: 'system', sourceId: 'body:self' }); counts.entities += body.id ? 1 : 0
    const legacySources = profiles.map(profile => ({
      profile,
      health: getHealthOverview({ profile, includeRecords: true }),
      personal: getPersonalStateOverview({ profile, limit: 10000 }),
    }))
    const profileAttributes = { ...subject.attributes }
    for (const { health } of [...legacySources].reverse()) Object.assign(profileAttributes, stableHealthProfileAttributes(health.healthProfile))
    subject = upsertTwinEntity({
      id: subject.id,
      type: subject.type,
      label: subject.label,
      attributes: profileAttributes,
      source: subject.source,
      sourceId: subject.sourceId,
    })
    for (const { profile, health, personal } of legacySources) {
      const profileSource = `health-state:${profile}`
      health.healthProfile.goals.forEach((goal, index) => { upsertTwinGoal({ subjectId: subject.id, domain: 'health', title: String(goal), target: {}, status: 'active', priority: 50, source: profileSource, sourceId: `goal:${index}:${String(goal)}` }); counts.goals += 1 })
      health.healthProfile.allergies.forEach((allergy, index) => { upsertTwinConstraint({ subjectId: subject.id, domain: 'health', key: 'allergy', value: allergy, enforcement: 'hard', source: profileSource, sourceId: `allergy:${index}:${String(allergy)}` }); counts.constraints += 1 })
      health.healthProfile.conditions.forEach((condition, index) => { upsertTwinConstraint({ subjectId: subject.id, domain: 'health', key: 'condition', value: condition, enforcement: 'advisory', source: profileSource, sourceId: `condition:${index}:${String(condition)}` }); counts.constraints += 1 })

      const records = health.records || []
      const scaleRecordedAt = new Set(records.filter(record => record.kind === 'scale_reading').map(record => String(record.recordedAt)))
      for (const record of records) {
        const id = String(record.id)
        const source = legacySource(profile, 'records', id)
        const recordedAt = legacyTimestamp(record, 'recordedAt', 'createdAt', 'updatedAt')
        const value = record.value && typeof record.value === 'object' ? record.value as Record<string, unknown> : { value: record.value }
        if (record.kind === 'scale_reading') {
          event({ eventType: 'health.scale.measured', subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id })
          counts.events += 1
          const metricMap: Record<string, string> = { weightKg: 'body.weight_kg', bmi: 'body.bmi', bodyFatPercent: 'body.fat_percent', muscleMassKg: 'body.muscle_mass_kg', visceralFatLevel: 'body.visceral_fat_level', basalMetabolismKcal: 'body.basal_metabolism_kcal' }
          for (const [key, metric] of Object.entries(metricMap)) if (typeof value[key] === 'number') { observation({ entityId: subject.id, metric, value: value[key], unit: metric.endsWith('_kg') ? 'kg' : null, observedAt: recordedAt, source, sourceId: id }); counts.observations += 1 }
        } else if (record.kind === 'weight' && !scaleRecordedAt.has(recordedAt)) {
          observation({ entityId: subject.id, metric: 'body.weight_kg', value: value.value, unit: typeof record.unit === 'string' ? record.unit : 'kg', observedAt: recordedAt, source, sourceId: id }); counts.observations += 1
        } else if (record.kind === 'body_measurement') {
          for (const [key, numeric] of numericEntries((value.measurements && typeof value.measurements === 'object' ? value.measurements : value) as Record<string, unknown>)) { observation({ entityId: subject.id, metric: `body.measurement.${key}`, value: numeric, observedAt: recordedAt, source, sourceId: `${id}:${key}` }); counts.observations += 1 }
        } else if (record.kind === 'posture_assessment' || record.kind === 'skin_assessment') {
          event({ eventType: record.kind === 'posture_assessment' ? 'health.posture.assessed' : 'health.skin.assessed', subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id }); counts.events += 1
        } else if (record.kind !== 'scale_reading') {
          event({ eventType: `health.record.${String(record.kind || 'unknown').replace(/[^a-z0-9_]+/gi, '_')}`, subjectId: subject.id, payload: { legacy: record }, occurredAt: recordedAt, source, sourceId: id }); counts.events += 1
        }
      }
      for (const workout of health.workouts || []) { const id = String(workout.id); event({ eventType: 'fitness.workout.logged', subjectId: subject.id, payload: { legacy: workout }, occurredAt: legacyTimestamp(workout, 'startedAt', 'createdAt', 'updatedAt'), source: legacySource(profile, 'workouts', id), sourceId: id }); counts.events += 1 }
      for (const food of health.foodLogs || []) { const id = String(food.id); event({ eventType: 'nutrition.meal.logged', subjectId: subject.id, payload: { legacy: food }, occurredAt: legacyTimestamp(food, 'loggedAt', 'createdAt', 'updatedAt'), source: legacySource(profile, 'foodLogs', id), sourceId: id }); counts.events += 1 }
      for (const checkin of health.dailyCheckins || []) { const id = String(checkin.id); event({ eventType: 'health.daily_checkin.recorded', subjectId: subject.id, payload: { legacy: checkin }, occurredAt: legacyTimestamp(checkin, 'checkinDate', 'checkin_date', 'createdAt', 'created_at'), source: legacySource(profile, 'dailyCheckins', id), sourceId: id }); counts.events += 1 }
      for (const plan of health.dailyPlans || []) { const id = String(plan.id); event({ eventType: 'health.plan.recorded', subjectId: subject.id, payload: { legacy: plan }, occurredAt: legacyTimestamp(plan as unknown as Record<string, unknown>, 'planDate'), source: legacySource(profile, 'dailyPlans', id), sourceId: id }); counts.events += 1 }
      for (const bodyMap of health.bodyMap || []) { const id = String(bodyMap.id); event({ eventType: 'health.body_region.assessed', subjectId: subject.id, payload: { legacy: bodyMap }, occurredAt: legacyTimestamp(bodyMap, 'recordedAt', 'createdAt', 'updatedAt'), source: legacySource(profile, 'bodyMap', id), sourceId: id }); counts.events += 1 }
      for (const supplement of health.supplementLogs || []) { const id = String(supplement.id); event({ eventType: 'health.supplement.taken', subjectId: subject.id, payload: { legacy: supplement }, occurredAt: legacyTimestamp(supplement, 'takenAt', 'createdAt', 'updatedAt'), source: legacySource(profile, 'supplementLogs', id), sourceId: id }); counts.events += 1 }
      for (const proposal of personal.proposals || []) { const id = String(proposal.id); event({ eventType: proposal.status === 'pending' ? 'personal.proposal.created' : 'personal.proposal.reviewed', subjectId: subject.id, payload: { legacy: proposal }, occurredAt: proposal.provenance.createdAt, source: personalSource(profile, 'proposals', id), sourceId: id }); counts.events += 1 }
      for (const task of personal.tasks || []) {
        const id = String(task.id)
        const source = personalSource(profile, 'tasks', id)
        const creationSnapshot = {
          kind: task.kind,
          id: task.id,
          title: task.title,
          summary: task.summary,
          notes: task.notes,
          sourceProposalId: task.sourceProposalId,
          provenance: {
            source: task.provenance.source,
            confidence: task.provenance.confidence,
            evidence: task.provenance.evidence,
            confirmationState: task.provenance.confirmationState,
            createdAt: task.provenance.createdAt,
          },
        }
        event({
          eventType: 'personal.task.created',
          subjectId: subject.id,
          payload: { legacy: creationSnapshot },
          occurredAt: task.provenance.createdAt,
          source,
          sourceId: id,
        })
        counts.events += 1
        event({
          eventType: 'personal.task.status_changed',
          subjectId: subject.id,
          payload: {
            status: task.status,
            actor: task.provenance.actor,
            legacy: { id: task.id, updatedAt: task.provenance.updatedAt },
          },
          occurredAt: task.provenance.updatedAt,
          source,
          sourceId: `${id}:${task.provenance.updatedAt}`,
        })
        counts.events += 1
      }
    }
    const completedAt = nowIso()
    withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_import_runs (id, source, source_fingerprint, status, counts_json, started_at, completed_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)`)
      .run(runId, 'legacy-personal-os', sourceFingerprint, JSON.stringify(counts), startedAt, completedAt))
    return { runId, profiles, status: 'completed', counts, startedAt, completedAt }
  } catch (error) {
    const completedAt = nowIso()
    withPersonalTwinDb(db => db.prepare(`INSERT OR REPLACE INTO twin_import_runs (id, source, source_fingerprint, status, counts_json, error, started_at, completed_at) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`)
      .run(runId, 'legacy-personal-os', sourceFingerprint, JSON.stringify(counts), String(error), startedAt, completedAt))
    throw error
  }
}
