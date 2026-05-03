import { request } from '../client'

export interface JobScheduleInterval {
  kind: 'interval'
  minutes: number
  display: string
}

export interface JobScheduleCron {
  kind: 'cron'
  expr: string
  display: string
}

export interface JobScheduleOnce {
  kind: 'once'
  run_at: string
  display: string
}

type UnknownJobSchedule = {
  kind: string
  display?: string
  expr?: string
  minutes?: number
  run_at?: string
}

export type JobSchedule = string | JobScheduleInterval | JobScheduleCron | JobScheduleOnce | UnknownJobSchedule

export interface Job {
  job_id: string
  id: string
  name: string
  prompt: string
  prompt_preview?: string
  skills: string[]
  skill: string | null
  model: string | null
  provider: string | null
  base_url: string | null
  script: string | null
  schedule: JobSchedule
  schedule_display: string
  repeat: string | { times: number | null; completed: number }
  enabled: boolean
  state: string
  paused_at: string | null
  paused_reason: string | null
  created_at: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  deliver: string
  origin: {
    platform: string
    chat_id: string
    chat_name: string
    thread_id: string | null
  } | null
  last_delivery_error: string | null
}

export interface CreateJobRequest {
  name: string
  schedule: string
  prompt?: string
  deliver?: string
  skills?: string[]
  repeat?: number
}

export interface UpdateJobRequest {
  name?: string
  schedule?: string
  prompt?: string
  deliver?: string
  skills?: string[]
  skill?: string
  repeat?: number | null
  enabled?: boolean
  model?: string
  provider?: string
}

export interface JobFormValues {
  name: string
  schedule: string
  prompt: string
  deliver: string
  repeat_times: number | null
}

function unwrap(res: { job: Job }): Job {
  return res.job
}

function isScheduleObject(schedule: JobSchedule | null | undefined): schedule is Exclude<JobSchedule, string> {
  return typeof schedule === 'object' && schedule !== null
}

export function scheduleToEditableInput(schedule: JobSchedule | null | undefined, fallback = ''): string {
  if (typeof schedule === 'string') return schedule
  if (!isScheduleObject(schedule)) return fallback

  if (schedule.kind === 'cron') return schedule.expr || schedule.display || fallback
  if (schedule.kind === 'once') return schedule.run_at || schedule.display || fallback
  if (schedule.kind === 'interval') {
    return schedule.display || (typeof schedule.minutes === 'number' ? `every ${schedule.minutes}m` : fallback)
  }

  const unknownSchedule = schedule as UnknownJobSchedule
  return unknownSchedule.expr || unknownSchedule.run_at || unknownSchedule.display || fallback
}

export function scheduleToDisplayText(schedule: JobSchedule | null | undefined, fallback = '—'): string {
  if (typeof schedule === 'string') return schedule
  if (!isScheduleObject(schedule)) return fallback

  if (schedule.kind === 'cron') return schedule.expr || schedule.display || fallback
  if (schedule.kind === 'interval') return schedule.display || scheduleToEditableInput(schedule, fallback)
  if (schedule.kind === 'once') return schedule.display || scheduleToEditableInput(schedule, fallback)

  const unknownSchedule = schedule as UnknownJobSchedule
  return unknownSchedule.display || unknownSchedule.expr || unknownSchedule.run_at || fallback
}

export function jobRepeatToEditValue(repeat: Job['repeat']): number | null {
  if (repeat && typeof repeat === 'object') return repeat.times ?? null
  return null
}

export function buildJobUpdateRequest(original: Job, form: JobFormValues): UpdateJobRequest {
  const payload: UpdateJobRequest = {}
  const originalSchedule = scheduleToEditableInput(original.schedule, original.schedule_display || '')
  const originalRepeat = jobRepeatToEditValue(original.repeat)
  const originalDeliver = original.deliver || 'origin'

  if (form.name !== original.name) payload.name = form.name
  if (form.schedule !== originalSchedule) payload.schedule = form.schedule
  if (form.prompt !== (original.prompt || '')) payload.prompt = form.prompt
  if (form.deliver !== originalDeliver) payload.deliver = form.deliver
  if (form.repeat_times !== originalRepeat) payload.repeat = form.repeat_times

  return payload
}

export async function listJobs(): Promise<Job[]> {
  const res = await request<{ jobs: Job[] }>('/api/hermes/jobs?include_disabled=true')
  return res.jobs
}

export async function getJob(jobId: string): Promise<Job> {
  return unwrap(await request<{ job: Job }>(`/api/hermes/jobs/${jobId}`))
}

export async function createJob(data: CreateJobRequest): Promise<Job> {
  return unwrap(await request<{ job: Job }>('/api/hermes/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  }))
}

export async function updateJob(jobId: string, data: UpdateJobRequest): Promise<Job> {
  return unwrap(await request<{ job: Job }>(`/api/hermes/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }))
}

export async function deleteJob(jobId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/hermes/jobs/${jobId}`, {
    method: 'DELETE',
  })
}

export async function pauseJob(jobId: string): Promise<Job> {
  return unwrap(await request<{ job: Job }>(`/api/hermes/jobs/${jobId}/pause`, { method: 'POST' }))
}

export async function resumeJob(jobId: string): Promise<Job> {
  return unwrap(await request<{ job: Job }>(`/api/hermes/jobs/${jobId}/resume`, { method: 'POST' }))
}

export async function runJob(jobId: string): Promise<Job> {
  return unwrap(await request<{ job: Job }>(`/api/hermes/jobs/${jobId}/run`, { method: 'POST' }))
}
