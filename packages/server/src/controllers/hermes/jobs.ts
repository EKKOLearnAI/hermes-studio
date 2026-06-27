import type { Context } from 'koa'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import {
  type CreateJobInput,
  createJobRecord,
  findJobRecord,
  readJobRecords,
  removeJobRecord,
  setJobPaused,
  type UpdateJobInput,
  updateJobRecord,
} from '../../services/hermes/cron/job-store'
import { runJobNow } from '../../services/hermes/cron/run-job'
import { getCronScheduler } from '../../services/hermes/cron/scheduler'
import { parseSchedule } from '../../services/hermes/cron/schedule'

function resolveProfile(ctx: Context): string {
  const requestedProfile = ctx.state?.profile?.name
  return requestedProfile || getActiveProfileName()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getBody(ctx: Context): Record<string, unknown> {
  return isRecord(ctx.request.body) ? ctx.request.body : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function boolQuery(value: unknown, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const text = String(value).toLowerCase()
  return text === '1' || text === 'true' || text === 'yes'
}

function getRepeatValue(repeat: unknown): number | null {
  if (repeat == null || repeat === '') return null
  if (typeof repeat === 'number') return Number.isFinite(repeat) ? repeat : null
  if (typeof repeat === 'string' && repeat.trim()) {
    const parsed = Number(repeat)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (isRecord(repeat)) {
    const times = repeat.times
    if (typeof times === 'number') return Number.isFinite(times) ? times : null
    if (typeof times === 'string' && times.trim()) {
      const parsed = Number(times)
      return Number.isFinite(parsed) ? parsed : null
    }
  }
  return null
}

function hasRepeatField(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'repeat')
}

function getSkills(body: Record<string, unknown>): string[] | null {
  const skills = body.skills
  if (Array.isArray(skills)) {
    return skills.map((skill) => String(skill ?? '').trim()).filter(Boolean)
  }
  if (typeof body.skill === 'string') {
    const skill = body.skill.trim()
    return skill ? [skill] : []
  }
  return null
}

function sendJobNotFound(ctx: Context): void {
  ctx.status = 404
  ctx.body = { error: { message: 'Job not found' } }
}

function sendBadRequest(ctx: Context, message: string): void {
  ctx.status = 400
  ctx.body = { error: { message } }
}

function sendCommandError(ctx: Context, error: unknown): void {
  ctx.status = 500
  ctx.body = { error: { message: error instanceof Error ? error.message : 'Scheduled job command failed' } }
}

export async function list(ctx: Context) {
  const profile = resolveProfile(ctx)
  const includeDisabled = boolQuery(ctx.query.include_disabled, false)
  ctx.body = { jobs: readJobRecords(profile, includeDisabled) }
}

export async function get(ctx: Context) {
  const profile = resolveProfile(ctx)
  const job = findJobRecord(profile, ctx.params.id)
  if (!job) return sendJobNotFound(ctx)
  ctx.body = { job }
}

export async function create(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  const schedule = (asString(body.schedule) ?? asString(body.schedule_display) ?? '').trim()

  if (!schedule) return sendBadRequest(ctx, 'Schedule is required')
  try {
    parseSchedule(schedule)
  } catch (error) {
    return sendBadRequest(ctx, error instanceof Error ? error.message : 'Invalid schedule')
  }

  const input: CreateJobInput = {
    schedule,
    name: asString(body.name),
    prompt: asString(body.prompt),
    deliver: asString(body.deliver),
    skills: getSkills(body),
    repeat: getRepeatValue(body.repeat),
    model: asString(body.model) ?? null,
    script: asString(body.script) ?? null,
    workdir: asString(body.workdir) ?? null,
    no_agent: body.no_agent === true,
  }

  try {
    const job = await createJobRecord(profile, input)
    getCronScheduler().reload(profile, job.job_id)
    ctx.body = { job }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}

export async function update(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  if (!findJobRecord(profile, ctx.params.id)) return sendJobNotFound(ctx)

  const patch: UpdateJobInput = {}
  if (body.name != null) patch.name = String(body.name)
  if (body.prompt != null) patch.prompt = String(body.prompt)
  if (body.deliver != null) patch.deliver = String(body.deliver)
  if (body.schedule != null || body.schedule_display != null) {
    patch.schedule = String(body.schedule ?? body.schedule_display)
    try {
      parseSchedule(patch.schedule)
    } catch (error) {
      return sendBadRequest(ctx, error instanceof Error ? error.message : 'Invalid schedule')
    }
  }
  const skills = getSkills(body)
  if (skills !== null) patch.skills = skills
  if (hasRepeatField(body)) patch.repeat = getRepeatValue(body.repeat)
  if (body.model !== undefined) patch.model = asString(body.model) ?? null
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled

  try {
    const job = await updateJobRecord(profile, ctx.params.id, patch)
    if (!job) return sendJobNotFound(ctx)
    getCronScheduler().reload(profile, job.job_id)
    ctx.body = { job }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}

export async function remove(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJobRecord(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await removeJobRecord(profile, ctx.params.id)
    getCronScheduler().reload(profile, ctx.params.id)
    ctx.body = { ok: true }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}

export async function pause(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJobRecord(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    const job = await setJobPaused(profile, ctx.params.id, true)
    getCronScheduler().reload(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}

export async function resume(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJobRecord(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    const job = await setJobPaused(profile, ctx.params.id, false)
    getCronScheduler().reload(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}

export async function run(ctx: Context) {
  const profile = resolveProfile(ctx)
  const job = findJobRecord(profile, ctx.params.id)
  if (!job) return sendJobNotFound(ctx)

  try {
    const updated = await runJobNow(profile, job, { countsTowardRepeat: false })
    getCronScheduler().reload(profile, ctx.params.id)
    ctx.body = { job: updated ?? job }
  } catch (error) {
    sendCommandError(ctx, error)
  }
}
