import type { Context } from 'koa'
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { getHermesBin } from '../../services/hermes/hermes-path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 60_000

type JobRecord = Record<string, any>

function resolveProfile(ctx: Context): string {
  const requestedProfile = ctx.state?.profile?.name
  return requestedProfile || getActiveProfileName()
}

function resolveProfileDir(profile: string): string {
  return getProfileDir(profile || 'default')
}

function getJobsPath(profile: string): string {
  return join(resolveProfileDir(profile), 'cron', 'jobs.json')
}

function normalizeJob(job: JobRecord): JobRecord {
  const id = job.job_id || job.id
  const skills = Array.isArray(job.skills)
    ? job.skills
    : (job.skill ? [job.skill] : [])

  return {
    ...job,
    id,
    job_id: id,
    skills,
    skill: job.skill ?? skills[0] ?? null,
    model: job.model ?? null,
    provider: job.provider ?? null,
    base_url: job.base_url ?? null,
    script: job.script ?? null,
    schedule_display: job.schedule_display ?? job.schedule?.display ?? job.schedule?.expr ?? '',
    repeat: job.repeat ?? { times: null, completed: 0 },
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

function readJobs(profile: string, includeDisabled = true): JobRecord[] {
  const jobsPath = getJobsPath(profile)
  if (!existsSync(jobsPath)) return []

  const parsed = JSON.parse(readFileSync(jobsPath, 'utf-8'))
  const rawJobs = Array.isArray(parsed) ? parsed : parsed?.jobs
  const jobs = Array.isArray(rawJobs) ? rawJobs.map(normalizeJob) : []

  if (includeDisabled) return jobs
  return jobs.filter((job) => job.enabled !== false)
}

function findJob(profile: string, jobId: string): JobRecord | null {
  return readJobs(profile, true).find((job) => job.job_id === jobId || job.id === jobId) ?? null
}

function boolQuery(value: unknown, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const text = String(value).toLowerCase()
  return text === '1' || text === 'true' || text === 'yes'
}

function getBody(ctx: Context): Record<string, any> {
  return (ctx.request.body && typeof ctx.request.body === 'object')
    ? ctx.request.body as Record<string, any>
    : {}
}

function getRepeatValue(repeat: unknown): number | null {
  if (repeat == null || repeat === '') return null
  if (typeof repeat === 'number' && Number.isFinite(repeat)) return repeat
  if (typeof repeat === 'object') {
    const times = (repeat as any).times
    if (typeof times === 'number' && Number.isFinite(times)) return times
    if (typeof times === 'string' && times.trim()) {
      const parsed = Number(times)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  const parsed = Number(repeat)
  return Number.isFinite(parsed) ? parsed : null
}

function hasRepeatField(body: Record<string, any>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'repeat')
}

function getSkills(body: Record<string, any>): string[] | null {
  if (Array.isArray(body.skills)) {
    return body.skills.map((skill) => String(skill || '').trim()).filter(Boolean)
  }
  if (typeof body.skill === 'string') {
    const skill = body.skill.trim()
    return skill ? [skill] : []
  }
  return null
}

async function runHermesCron(profile: string, args: string[]): Promise<void> {
  const profileDir = resolveProfileDir(profile)
  try {
    await execFileAsync(getHermesBin(), args, {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_HOME: profileDir },
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  } catch (error: any) {
    const stderr = String(error?.stderr || '').trim()
    const stdout = String(error?.stdout || '').trim()
    throw new Error(stderr || stdout || error?.message || 'Hermes cron command failed')
  }
}

function sendJobNotFound(ctx: Context): void {
  ctx.status = 404
  ctx.body = { error: { message: 'Job not found' } }
}

function sendCommandError(ctx: Context, error: any): void {
  ctx.status = 500
  ctx.body = { error: { message: error?.message || 'Hermes cron command failed' } }
}

function findCreatedJob(beforeJobs: JobRecord[], afterJobs: JobRecord[]): JobRecord | null {
  const beforeIds = new Set(beforeJobs.map((job) => job.job_id || job.id))
  const created = afterJobs.find((job) => !beforeIds.has(job.job_id || job.id))
  if (created) return created

  return [...afterJobs].sort((a, b) => {
    const aTime = Date.parse(a.created_at || '') || 0
    const bTime = Date.parse(b.created_at || '') || 0
    return bTime - aTime
  })[0] ?? null
}

export async function list(ctx: Context) {
  const profile = resolveProfile(ctx)
  const includeDisabled = boolQuery(ctx.query.include_disabled, false)
  ctx.body = { jobs: readJobs(profile, includeDisabled) }
}

export async function get(ctx: Context) {
  const profile = resolveProfile(ctx)
  const job = findJob(profile, ctx.params.id)
  if (!job) return sendJobNotFound(ctx)
  ctx.body = { job }
}

export async function create(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  const schedule = String(body.schedule || body.schedule_display || '').trim()
  const prompt = String(body.prompt || '').trim()

  if (!schedule) {
    ctx.status = 400
    ctx.body = { error: { message: 'Schedule is required' } }
    return
  }

  const beforeJobs = readJobs(profile, true)
  const args = ['cron', 'create']
  const name = String(body.name || '').trim()
  if (name) args.push('--name', name)
  if (body.deliver != null && String(body.deliver).trim()) args.push('--deliver', String(body.deliver).trim())

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  const skills = getSkills(body)
  for (const skill of skills || []) args.push('--skill', skill)

  if (body.script != null && String(body.script).trim()) args.push('--script', String(body.script).trim())
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')

  args.push(schedule)
  if (prompt) args.push(prompt)

  try {
    await runHermesCron(profile, args)
    const job = findCreatedJob(beforeJobs, readJobs(profile, true))
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function update(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  const args = ['cron', 'edit', ctx.params.id]
  if (body.schedule != null || body.schedule_display != null) {
    args.push('--schedule', String(body.schedule ?? body.schedule_display))
  }
  if (body.prompt != null) args.push('--prompt', String(body.prompt))
  if (body.name != null) args.push('--name', String(body.name))
  if (body.deliver != null) args.push('--deliver', String(body.deliver))

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  const skills = getSkills(body)
  if (skills) {
    if (skills.length === 0) {
      args.push('--clear-skills')
    } else {
      for (const skill of skills) args.push('--skill', skill)
    }
  }

  if (body.script != null) args.push('--script', String(body.script))
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')
  if (body.no_agent === false) args.push('--agent')

  try {
    await runHermesCron(profile, args)
    const job = findJob(profile, ctx.params.id)
    if (!job) return sendJobNotFound(ctx)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function remove(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, ['cron', 'remove', ctx.params.id])
    ctx.body = { ok: true }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function pause(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, ['cron', 'pause', ctx.params.id])
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function resume(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, ['cron', 'resume', ctx.params.id])
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function run(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, ['cron', 'run', ctx.params.id])
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}
