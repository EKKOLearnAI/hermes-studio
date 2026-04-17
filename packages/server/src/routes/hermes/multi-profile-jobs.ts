import Router from '@koa/router'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync as exists } from 'fs'

const execFileAsync = promisify(execFile)
const HERMES_BASE = resolve(homedir(), '.hermes')
const PROFILES_DIR = join(HERMES_BASE, 'profiles')

function resolveHermesBin(): string {
  const candidates = [
    process.env.HERMES_BIN?.trim(),
    resolve(homedir(), 'hermes-agent', 'venv', 'bin', 'hermes'),
    resolve(homedir(), 'hermes-agent', '.venv', 'bin', 'hermes'),
    resolve(homedir(), 'bin', 'hermes'),
    'hermes',
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (candidate === 'hermes' || exists(candidate)) {
      return candidate
    }
  }
  return 'hermes'
}

const HERMES_BIN = resolveHermesBin()
const execOpts = { windowsHide: true }

// ─── Read jobs from filesystem (lightweight) ────────────────

function readJobsForProfile(profileName: string): { profile: string; jobs: any[]; error?: string } {
  const profileDir = join(PROFILES_DIR, profileName)
  const jobsFile = join(profileDir, 'cron', 'jobs.json')

  if (!existsSync(jobsFile)) {
    return { profile: profileName, jobs: [] }
  }

  try {
    const raw = readFileSync(jobsFile, 'utf-8')
    const data = JSON.parse(raw)
    const jobs: any[] = data.jobs || (Array.isArray(data) ? data : [])
    // Tag each job with its profile
    for (const j of jobs) j._profile = profileName
    return { profile: profileName, jobs }
  } catch (err: any) {
    return { profile: profileName, jobs: [], error: err.message }
  }
}

function getActiveProfileName(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

// ─── CLI wrapper for profile-scoped cron operations ─────────

async function cronCli(profile: string, args: string[]): Promise<string> {
  const fullArgs = ['--profile', profile, 'cron', ...args]
  const { stdout, stderr } = await execFileAsync(HERMES_BIN, fullArgs, {
    timeout: 30000,
    ...execOpts,
  })
  return (stdout || stderr).trim()
}

// ─── Routes ─────────────────────────────────────────────────

export const multiProfileJobsRoutes = new Router()

// GET /api/hermes/jobs/all-profiles
multiProfileJobsRoutes.get('/api/hermes/jobs/all-profiles', async (ctx) => {
  try {
    const results: any[] = []

    if (existsSync(PROFILES_DIR)) {
      const entries = readdirSync(PROFILES_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          results.push(readJobsForProfile(entry.name))
        }
      }
    }

    ctx.body = { profiles: results, activeProfile: getActiveProfileName() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/hermes/jobs/profile/:profile/create
multiProfileJobsRoutes.post('/api/hermes/jobs/profile/:profile/create', async (ctx) => {
  const { profile } = ctx.params
  const body = ctx.request.body as any

  if (!body?.schedule) {
    ctx.status = 400
    ctx.body = { error: 'Schedule is required' }
    return
  }

  try {
    const args: string[] = []
    if (body.name) args.push('--name', body.name)
    if (body.deliver) args.push('--deliver', body.deliver)
    if (body.repeat) args.push('--repeat', String(body.repeat))
    if (body.skill) args.push('--skill', body.skill)

    // Positional: schedule [prompt]
    args.push(body.schedule)
    if (body.prompt) args.push(body.prompt)

    const output = await cronCli(profile, ['create', ...args])
    // Re-read jobs to return updated list
    const result = readJobsForProfile(profile)
    ctx.body = { success: true, message: output, profile: result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/hermes/jobs/profile/:profile/:jobId/pause
multiProfileJobsRoutes.post('/api/hermes/jobs/profile/:profile/:jobId/pause', async (ctx) => {
  const { profile, jobId } = ctx.params
  try {
    const output = await cronCli(profile, ['pause', jobId])
    const result = readJobsForProfile(profile)
    ctx.body = { success: true, message: output, profile: result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/hermes/jobs/profile/:profile/:jobId/resume
multiProfileJobsRoutes.post('/api/hermes/jobs/profile/:profile/:jobId/resume', async (ctx) => {
  const { profile, jobId } = ctx.params
  try {
    const output = await cronCli(profile, ['resume', jobId])
    const result = readJobsForProfile(profile)
    ctx.body = { success: true, message: output, profile: result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/hermes/jobs/profile/:profile/:jobId/run
multiProfileJobsRoutes.post('/api/hermes/jobs/profile/:profile/:jobId/run', async (ctx) => {
  const { profile, jobId } = ctx.params
  try {
    const output = await cronCli(profile, ['run', jobId])
    const result = readJobsForProfile(profile)
    ctx.body = { success: true, message: output, profile: result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// DELETE /api/hermes/jobs/profile/:profile/:jobId
multiProfileJobsRoutes.delete('/api/hermes/jobs/profile/:profile/:jobId', async (ctx) => {
  const { profile, jobId } = ctx.params
  try {
    const output = await cronCli(profile, ['remove', jobId])
    const result = readJobsForProfile(profile)
    ctx.body = { success: true, message: output, profile: result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
