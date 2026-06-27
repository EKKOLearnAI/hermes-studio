/**
 * JobStore — the web-ui owner of `<profileDir>/cron/jobs.json`.
 *
 * Replaces the `hermes cron` CLI: all create/update/pause/resume/remove/run
 * bookkeeping now happens here as direct, atomic read-modify-write file ops.
 * The on-disk schema (see `normalizeJobRecord`) and `{ jobs: [...] }` envelope
 * are kept byte-compatible with what the Hermes CLI wrote so the existing client
 * and `cron-history` controller need no changes.
 *
 * All mutations run under a per-profile in-process lock: within the single Node
 * server the only writers are REST handlers and the scheduler, so serializing
 * them removes read-modify-write races without any external file locking.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getProfileDir } from '../hermes-profile'
import { nextRunAfter, parseSchedule } from './schedule'

export interface JobScheduleObject {
  kind: string
  expr?: string
  display?: string
  minutes?: number
  run_at?: string
}

export interface JobRepeat {
  times: number | null
  completed: number
}

export interface JobRecord {
  job_id: string
  id: string
  name: string
  prompt: string
  schedule: string | JobScheduleObject
  schedule_display: string
  skills: string[]
  skill: string | null
  model: string | null
  provider: string | null
  base_url: string | null
  script: string | null
  workdir: string | null
  no_agent?: boolean
  deliver: string
  origin: unknown
  repeat: JobRepeat
  enabled: boolean
  state: string
  paused_at: string | null
  paused_reason: string | null
  created_at: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  last_delivery_error: string | null
  run_count: number
  /** Unknown extras from older/compatible writers are preserved on round-trip. */
  [key: string]: unknown
}

/** A record as it may exist on disk before normalization. */
type RawJobRecord = Partial<JobRecord>

export interface CreateJobInput {
  name?: string | null
  schedule: string
  prompt?: string | null
  deliver?: string | null
  skills?: string[] | null
  repeat?: number | null
  model?: string | null
  script?: string | null
  workdir?: string | null
  no_agent?: boolean
}

export interface UpdateJobInput {
  name?: string | null
  schedule?: string | null
  prompt?: string | null
  deliver?: string | null
  skills?: string[] | null
  repeat?: number | null
  model?: string | null
  enabled?: boolean
}

export interface RunResultInput {
  status: 'success' | 'error'
  error?: string | null
  ranAt: string
  /** Scheduled fires count toward the repeat budget; manual runs do not. */
  countsTowardRepeat: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getJobsPath(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'cron', 'jobs.json')
}

function matchesId(job: RawJobRecord, jobId: string): boolean {
  return job.job_id === jobId || job.id === jobId
}

function repeatTimes(repeat: number | null | undefined): number | null {
  // Hermes semantics: repeat <= 0 (or absent) means unbounded.
  if (typeof repeat === 'number' && Number.isFinite(repeat) && repeat > 0) return repeat
  return null
}

function normalizeSkills(skills: string[] | null | undefined): string[] {
  if (!Array.isArray(skills)) return []
  return skills.map((skill) => String(skill || '').trim()).filter(Boolean)
}

function scheduleDisplay(schedule: string | JobScheduleObject | undefined): string {
  if (typeof schedule === 'string') return schedule
  if (schedule && typeof schedule === 'object') return schedule.display ?? schedule.expr ?? ''
  return ''
}

/** Cron expression backing a job record, or null when not a cron schedule. */
export function jobScheduleExpr(job: RawJobRecord): string | null {
  const schedule = job.schedule
  if (typeof schedule === 'string' && schedule.trim()) return schedule.trim()
  if (schedule && typeof schedule === 'object') {
    if (schedule.kind && schedule.kind !== 'cron') return null
    const expr = schedule.expr || schedule.display
    if (typeof expr === 'string' && expr.trim()) return expr.trim()
  }
  if (typeof job.schedule_display === 'string' && job.schedule_display.trim()) return job.schedule_display.trim()
  return null
}

function computeNextRun(job: RawJobRecord, from: Date): string | null {
  const expr = jobScheduleExpr(job)
  if (!expr) return null
  try {
    return nextRunAfter(parseSchedule(expr), from)?.toISOString() ?? null
  } catch {
    return null
  }
}

/** Normalize a raw record into the API/scheduler shape (mirrors the prior CLI controller). */
export function normalizeJobRecord(job: RawJobRecord): JobRecord {
  const id = job.job_id || job.id || ''
  const skills = Array.isArray(job.skills)
    ? job.skills
    : (typeof job.skill === 'string' && job.skill ? [job.skill] : [])
  const repeat: JobRepeat = job.repeat && typeof job.repeat === 'object'
    ? { times: job.repeat.times ?? null, completed: job.repeat.completed ?? 0 }
    : { times: null, completed: 0 }

  return {
    ...job,
    id,
    job_id: id,
    name: job.name ?? '',
    prompt: job.prompt ?? '',
    schedule: job.schedule ?? '',
    schedule_display: job.schedule_display ?? scheduleDisplay(job.schedule),
    skills,
    skill: job.skill ?? skills[0] ?? null,
    model: job.model ?? null,
    provider: job.provider ?? null,
    base_url: job.base_url ?? null,
    script: job.script ?? null,
    workdir: job.workdir ?? null,
    repeat,
    run_count: job.run_count ?? repeat.completed ?? 0,
    enabled: job.enabled ?? true,
    state: job.state ?? ((job.enabled ?? true) ? 'scheduled' : 'paused'),
    paused_at: job.paused_at ?? null,
    paused_reason: job.paused_reason ?? null,
    created_at: job.created_at ?? '',
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    last_status: job.last_status ?? null,
    last_error: job.last_error ?? null,
    deliver: job.deliver ?? 'local',
    origin: job.origin ?? null,
    last_delivery_error: job.last_delivery_error ?? null,
  }
}

function readRawRecords(profile: string): RawJobRecord[] {
  const path = getJobsPath(profile)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const raw = Array.isArray(parsed) ? parsed : (isRecord(parsed) ? parsed.jobs : undefined)
    if (!Array.isArray(raw)) return []
    // Entries come from our own writes (or the Hermes CLI's compatible schema);
    // keep only objects and treat them as partial job records.
    return raw.filter(isRecord) as RawJobRecord[]
  } catch {
    return []
  }
}

function writeRawRecords(profile: string, records: RawJobRecord[]): void {
  const path = getJobsPath(profile)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ jobs: records }, null, 2), 'utf-8')
  renameSync(tmp, path)
}

// Per-profile mutation lock: chains async ops so read-modify-write never races.
const profileLocks = new Map<string, Promise<unknown>>()

function withProfileLock<T>(profile: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = profileLocks.get(profile) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  profileLocks.set(profile, run.then(() => undefined, () => undefined))
  return run
}

/** All jobs (normalized). `includeDisabled=false` drops `enabled === false`. */
export function readJobRecords(profile: string, includeDisabled = true): JobRecord[] {
  const records = readRawRecords(profile).map(normalizeJobRecord)
  return includeDisabled ? records : records.filter((job) => job.enabled !== false)
}

export function findJobRecord(profile: string, jobId: string): JobRecord | null {
  return readJobRecords(profile, true).find((job) => matchesId(job, jobId)) ?? null
}

export async function createJobRecord(profile: string, input: CreateJobInput): Promise<JobRecord> {
  // Parse outside the lock so invalid schedules fail fast without touching disk.
  const schedule = parseSchedule(input.schedule)
  return withProfileLock(profile, () => {
    const records = readRawRecords(profile)
    const id = randomUUID().replace(/-/g, '').slice(0, 12)
    const now = new Date()
    const record: JobRecord = {
      job_id: id,
      id,
      name: (input.name ?? '').trim(),
      prompt: (input.prompt ?? '').trim(),
      schedule: { kind: 'cron', expr: schedule.expr, display: schedule.display },
      schedule_display: schedule.display,
      skills: normalizeSkills(input.skills),
      skill: null,
      model: input.model ?? null,
      provider: null,
      base_url: null,
      script: input.script ?? null,
      workdir: input.workdir ?? null,
      deliver: (input.deliver ?? '').trim() || 'origin',
      origin: null,
      repeat: { times: repeatTimes(input.repeat), completed: 0 },
      enabled: true,
      state: 'scheduled',
      paused_at: null,
      paused_reason: null,
      created_at: now.toISOString(),
      next_run_at: nextRunAfter(schedule, now)?.toISOString() ?? null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_delivery_error: null,
      run_count: 0,
    }
    if (input.no_agent === true) record.no_agent = true
    records.push(record)
    writeRawRecords(profile, records)
    return normalizeJobRecord(record)
  })
}

export async function updateJobRecord(profile: string, jobId: string, patch: UpdateJobInput): Promise<JobRecord | null> {
  // Validate a new schedule before locking.
  const newSchedule = patch.schedule != null ? parseSchedule(String(patch.schedule)) : null
  return withProfileLock(profile, () => {
    const records = readRawRecords(profile)
    const record = records.find((job) => matchesId(job, jobId))
    if (!record) return null

    if (patch.name != null) record.name = String(patch.name)
    if (patch.prompt != null) record.prompt = String(patch.prompt)
    if (patch.deliver != null) record.deliver = String(patch.deliver)
    if (patch.skills !== undefined) record.skills = normalizeSkills(patch.skills)
    if (patch.model !== undefined) record.model = patch.model ?? null
    if (patch.enabled !== undefined) {
      record.enabled = patch.enabled !== false
      record.state = record.enabled ? 'scheduled' : 'paused'
    }
    if (newSchedule) {
      record.schedule = { kind: 'cron', expr: newSchedule.expr, display: newSchedule.display }
      record.schedule_display = newSchedule.display
      record.next_run_at = nextRunAfter(newSchedule, new Date())?.toISOString() ?? null
    }
    if (patch.repeat !== undefined) {
      const completed = record.repeat?.completed ?? 0
      record.repeat = { times: repeatTimes(patch.repeat), completed }
    }

    writeRawRecords(profile, records)
    return normalizeJobRecord(record)
  })
}

export async function removeJobRecord(profile: string, jobId: string): Promise<boolean> {
  return withProfileLock(profile, () => {
    const records = readRawRecords(profile)
    const next = records.filter((job) => !matchesId(job, jobId))
    if (next.length === records.length) return false
    writeRawRecords(profile, next)
    return true
  })
}

export async function setJobPaused(profile: string, jobId: string, paused: boolean, reason?: string): Promise<JobRecord | null> {
  return withProfileLock(profile, () => {
    const records = readRawRecords(profile)
    const record = records.find((job) => matchesId(job, jobId))
    if (!record) return null

    if (paused) {
      record.state = 'paused'
      record.paused_at = new Date().toISOString()
      record.paused_reason = reason ?? null
    } else {
      record.state = 'scheduled'
      record.enabled = true
      record.paused_at = null
      record.paused_reason = null
      record.next_run_at = computeNextRun(record, new Date())
    }

    writeRawRecords(profile, records)
    return normalizeJobRecord(record)
  })
}

export async function recordRunResult(profile: string, jobId: string, result: RunResultInput): Promise<JobRecord | null> {
  return withProfileLock(profile, () => {
    const records = readRawRecords(profile)
    const record = records.find((job) => matchesId(job, jobId))
    if (!record) return null

    record.last_run_at = result.ranAt
    record.last_status = result.status
    record.last_error = result.error ?? null
    record.run_count = (record.run_count ?? 0) + 1

    const times = record.repeat?.times ?? null
    let completed = record.repeat?.completed ?? 0
    if (result.countsTowardRepeat) completed += 1
    record.repeat = { times, completed }

    if (result.countsTowardRepeat && times != null && completed >= times) {
      record.enabled = false
      record.state = 'completed'
      record.next_run_at = null
    } else {
      record.next_run_at = computeNextRun(record, new Date())
    }

    writeRawRecords(profile, records)
    return normalizeJobRecord(record)
  })
}
