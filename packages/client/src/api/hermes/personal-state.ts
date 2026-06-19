import { request } from '@/api/client'

export type PersonalRiskLevel = 'low' | 'medium' | 'high'
export type PersonalProposalStatus = 'pending' | 'approved' | 'rejected'

export interface PersonalProposal {
  id: string
  title: string
  summary: string
  riskLevel: PersonalRiskLevel
  status: PersonalProposalStatus
  proposedAction: { type: string; payload: Record<string, unknown> }
  targetRecordIds: string[]
  provenance: {
    source: string
    confidence: number
    evidence: Array<Record<string, unknown>>
    confirmationState: string
    actor: string
    createdAt: string
    updatedAt: string
    reviewedBy: string | null
    reviewedAt: string | null
  }
}

export interface PersonalTask {
  kind: 'task'
  id: string
  title: string
  summary: string
  notes: string
  status: string
  sourceProposalId: string | null
  provenance: {
    source: string
    confidence: number
    evidence: Array<Record<string, unknown>>
    confirmationState: string
    actor: string
    createdAt: string
    updatedAt: string
  }
}

export interface PersonalMemoryContext {
  id: string
  generatedAt: string
  profile: string
  query: string | null
  summary: string
  relevantRecordIds: string[]
  contextBlocks: Array<Record<string, unknown>>
}

export interface PersonalStateOverview {
  generatedAt: string
  profile: string
  query: string | null
  proposals: PersonalProposal[]
  tasks: PersonalTask[]
  pendingProposals: PersonalProposal[]
  memoryContext: PersonalMemoryContext
}

function withProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}profile=${encodeURIComponent(profile)}`
}

export async function fetchPersonalStateOverview(options: { profile?: string | null; query?: string } = {}): Promise<PersonalStateOverview> {
  const params = new URLSearchParams()
  if (options.profile) params.set('profile', options.profile)
  if (options.query) params.set('query', options.query)
  const suffix = params.toString() ? `?${params}` : ''
  const res = await request<{ overview: PersonalStateOverview }>(`/api/hermes/personal-state/overview${suffix}`)
  return res.overview
}

export async function approvePersonalStateProposal(id: string, profile?: string | null): Promise<PersonalProposal> {
  const res = await request<{ proposal: PersonalProposal }>(
    withProfile(`/api/hermes/personal-state/proposals/${encodeURIComponent(id)}/approve`, profile),
    { method: 'POST' },
  )
  return res.proposal
}

export async function rejectPersonalStateProposal(id: string, profile?: string | null): Promise<PersonalProposal> {
  const res = await request<{ proposal: PersonalProposal }>(
    withProfile(`/api/hermes/personal-state/proposals/${encodeURIComponent(id)}/reject`, profile),
    { method: 'POST' },
  )
  return res.proposal
}

export async function checkInPersonalStateTask(id: string, profile?: string | null): Promise<PersonalTask> {
  const res = await request<{ task: PersonalTask }>(
    withProfile(`/api/hermes/personal-state/tasks/${encodeURIComponent(id)}/check-in`, profile),
    { method: 'POST' },
  )
  return res.task
}
