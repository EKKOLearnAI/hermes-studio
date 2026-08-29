import { request } from '@/api/client'

export type EkkoMemoryStatus = 'active' | 'superseded' | 'expired' | 'deleted'

export interface EkkoMemoryNode {
  id: string
  parentId?: string
  supersedesId?: string
  profileId: string
  scope?:
    | { type: 'profile' }
    | { type: 'context'; namespace: string; id: string }
    | { type: 'session'; id: string }
  origin?: { host?: string; namespace?: string; contextId?: string }
  domain: string
  categoryPath: string[]
  type: string
  key: string
  revision: number
  valueJson?: unknown
  title: string
  content: string
  status: EkkoMemoryStatus
  confidence: number
  importance: number
  tags: string[]
  entities: string[]
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}

export interface EkkoMemoryReviewStatus {
  reviewing: boolean
  activeJobs: number
  pending: number
  running: number
  retry: number
  waitingForModel: number
  needsConfirmation: number
  latestCompletedAt?: string
}

export type EkkoMemoryReviewJobStatus =
  | 'pending'
  | 'running'
  | 'retry'
  | 'waiting_for_model'
  | 'needs_confirmation'

export interface EkkoMemoryReviewJob {
  id: string
  sessionId: string
  throughMessageId: string
  trigger: 'review' | 'forget' | 'periodic'
  status: EkkoMemoryReviewJobStatus
  attempt: number
  userConfirmed: boolean
  evidencePreview?: string
  lastError?: string
  nextAttemptAt?: string
  createdAt: string
  updatedAt: string
}

export async function fetchEkkoMemory(input: {
  query?: string
  status?: EkkoMemoryStatus
} = {}): Promise<EkkoMemoryNode[]> {
  const params = new URLSearchParams()
  if (input.query) params.set('query', input.query)
  if (input.status) params.set('status', input.status)
  const suffix = params.size ? `?${params.toString()}` : ''
  const response = await request<{ ok: boolean; memories: EkkoMemoryNode[] }>(`/api/ekko/memory${suffix}`)
  return response.memories
}

export async function fetchEkkoMemoryReviewStatus(): Promise<EkkoMemoryReviewStatus> {
  const response = await request<{ ok: boolean; status: EkkoMemoryReviewStatus }>('/api/ekko/memory/review-status')
  return response.status
}

export async function fetchEkkoMemoryReviewJobs(): Promise<EkkoMemoryReviewJob[]> {
  const response = await request<{ ok: boolean; jobs: EkkoMemoryReviewJob[] }>('/api/ekko/memory/review-jobs')
  return response.jobs
}

export async function reviewEkkoMemoryJobNow(id: string): Promise<EkkoMemoryReviewJob> {
  const response = await request<{ ok: boolean; job: EkkoMemoryReviewJob }>(
    `/api/ekko/memory/review-jobs/${encodeURIComponent(id)}/review`,
    { method: 'POST' },
  )
  return response.job
}

export async function updateEkkoMemory(
  id: string,
  input: { expectedRevision: number; title: string; content: string; tags: string[] },
): Promise<EkkoMemoryNode> {
  const response = await request<{ ok: boolean; memory: EkkoMemoryNode }>(`/api/ekko/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return response.memory
}

export async function deleteEkkoMemory(id: string, expectedRevision: number): Promise<void> {
  await request(`/api/ekko/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision }),
  })
}
