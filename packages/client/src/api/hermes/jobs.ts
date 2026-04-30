import { request } from '../client'

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
  schedule: string | { kind: string; expr: string; display: string }
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
  schedule?: string | { kind: string; expr: string; display: string }
  prompt?: string
  deliver?: string
  skills?: string[]
  skill?: string
  repeat?: number
  enabled?: boolean
  model?: string
  provider?: string
}

function unwrap(res: { job: Job }): Job {
  return res.job
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
