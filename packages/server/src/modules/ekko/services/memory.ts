import type {
  EkkoAgentSetup,
  MemoryNode,
  MemoryNodeStatus,
  MemoryReviewJob,
  MemoryReviewJobStatus,
  MemoryReviewQueueStatus,
} from '../../../../../ekko-agent/src'
import { MEMORY_NODE_STATUSES } from '../../../../../ekko-agent/src'
import { setupGlobalEkkoAgent } from './manager'

export interface ListEkkoMemoryInput {
  profile: string
  query?: string
  status?: MemoryNodeStatus
  limit?: number
  offset?: number
}

export interface UpdateEkkoMemoryInput {
  expectedRevision: number
  title?: string
  content?: string
  tags?: string[]
}

export interface EkkoMemoryReviewJobView {
  id: string
  sessionId: string
  throughMessageId: string
  trigger: MemoryReviewJob['request']['trigger']
  status: MemoryReviewJobStatus
  attempt: number
  userConfirmed: boolean
  evidencePreview?: string
  lastError?: string
  nextAttemptAt?: string
  createdAt: string
  updatedAt: string
}

function resolveSetup(setup?: EkkoAgentSetup): EkkoAgentSetup {
  return setup || setupGlobalEkkoAgent()
}

function normalizeProfile(profile: string): string {
  return String(profile || '').trim() || 'default'
}

export async function listEkkoMemory(
  input: ListEkkoMemoryInput,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode[]> {
  const profile = normalizeProfile(input.profile)
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500)
  const offset = Math.max(Number(input.offset) || 0, 0)
  return resolveSetup(setup).memory.list({
    profileId: profile,
    queryText: String(input.query || '').trim() || undefined,
    statuses: input.status ? [input.status] : [...MEMORY_NODE_STATUSES],
    limit,
    offset,
  })
}

export async function getEkkoMemoryReviewStatus(
  profileInput: string,
  setup?: EkkoAgentSetup,
): Promise<MemoryReviewQueueStatus> {
  return resolveSetup(setup).memory.getReviewStatus(normalizeProfile(profileInput))
}

export async function listEkkoMemoryReviewJobs(
  profileInput: string,
  setup?: EkkoAgentSetup,
): Promise<EkkoMemoryReviewJobView[]> {
  const memory = resolveSetup(setup).memory
  const jobs = await memory.listReviewJobs(normalizeProfile(profileInput))
  const sessions = new Map<string, Awaited<ReturnType<typeof memory.listMessages>>>()
  await Promise.all([...new Set(jobs.map(job => job.sessionId))].map(async sessionId => {
    sessions.set(sessionId, await memory.listMessages({ sessionId, limit: 50 }))
  }))
  return jobs.map(job => toReviewJobView(job, reviewEvidencePreview(job, sessions.get(job.sessionId) || [])))
}

export async function reviewEkkoMemoryJobNow(
  profileInput: string,
  id: string,
  setup?: EkkoAgentSetup,
): Promise<EkkoMemoryReviewJobView> {
  const job = await resolveSetup(setup).memory.reviewJobNow(id, normalizeProfile(profileInput))
  if (!job) throw new Error('Memory review job not found.')
  const messages = await resolveSetup(setup).memory.listMessages({ sessionId: job.sessionId, limit: 50 })
  return toReviewJobView(job, reviewEvidencePreview(job, messages))
}

function toReviewJobView(job: MemoryReviewJob, evidencePreview?: string): EkkoMemoryReviewJobView {
  return {
    id: job.id,
    sessionId: job.sessionId,
    throughMessageId: job.throughMessageId,
    trigger: job.request.trigger,
    status: job.status,
    attempt: job.attempt,
    userConfirmed: job.request.userConfirmed === true,
    evidencePreview,
    lastError: job.lastError,
    nextAttemptAt: job.nextAttemptAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function reviewEvidencePreview(
  job: MemoryReviewJob,
  messages: Awaited<ReturnType<EkkoAgentSetup['memory']['listMessages']>>,
): string | undefined {
  const throughIndex = messages.findIndex(message => message.id === job.throughMessageId)
  const bounded = throughIndex >= 0 ? messages.slice(0, throughIndex + 1) : messages
  const content = [...bounded].reverse().find(message => message.role === 'user')?.content.trim()
  if (!content) return undefined
  return content.length > 240 ? `${content.slice(0, 237)}…` : content
}

export async function updateEkkoMemory(
  profileInput: string,
  id: string,
  input: UpdateEkkoMemoryInput,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode> {
  const profile = normalizeProfile(profileInput)
  const current = await resolveSetup(setup).memory.get(id, { profileId: profile })
  if (!current) throw new Error('Memory not found.')

  const result = await resolveSetup(setup).memory.update(id, {
    expectedRevision: input.expectedRevision,
    node: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    },
    reason: 'Updated from Ekko memory settings.',
    actor: 'studio-user',
    explicitUserIntent: true,
    identity: { profileId: profile },
  })
  if (!result.accepted || !result.node) {
    throw new Error(result.reason || 'Memory update failed.')
  }
  return result.node
}

export async function deleteEkkoMemory(
  profileInput: string,
  id: string,
  expectedRevision: number,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode> {
  const profile = normalizeProfile(profileInput)
  const current = await resolveSetup(setup).memory.get(id, { profileId: profile })
  if (!current) throw new Error('Memory not found.')

  const result = await resolveSetup(setup).memory.delete(id, {
    expectedRevision,
    mode: 'soft',
    reason: 'Deleted from Ekko memory settings.',
    actor: 'studio-user',
    identity: { profileId: profile },
  })
  const deleted = result.deletedMemories?.[0]
  if (!deleted) throw new Error(result.reason || 'Memory delete failed.')
  return deleted
}
