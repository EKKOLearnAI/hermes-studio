import { request } from '@/api/client'

export type InternetCapabilityId = 'bilibili.video.search' | 'bilibili.video.inspect'
export type InternetExecutorType = 'mcp' | 'browser'
export type InternetReceiptStatus = 'prepared' | 'executing' | 'executed' | 'verifying' | 'verified'
  | 'unknown' | 'mismatch' | 'failed' | 'waiting_user'
export type InternetWorkflowState = 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating' | 'succeeded' | 'denied' | 'cancelled'
  | 'failed' | 'dead_letter' | 'compensated'

export interface InternetProviderDto {
  provider: 'bilibili'; profile: string; active: boolean; configured: boolean
  discoveryStatus: 'stopped' | 'unavailable' | 'degraded' | 'healthy'; executorEnabled: boolean
  selectedExecutorType: InternetExecutorType | null; authorizedTargetCount: number; lastErrorCode: string | null
}
export interface InternetExecutorDto {
  type: InternetExecutorType; environment: 'production'; enabled: boolean
  health: 'healthy' | 'degraded' | 'unavailable' | 'unknown'; selected: boolean
}
export interface InternetCapabilityDto { id: InternetCapabilityId; provider: 'bilibili'; available: boolean }
export interface InternetOverviewSummaryDto {
  receiptCount: number; verifiedReceiptCount: number; waitingUserReceiptCount: number; activeWorkflowCount: number
}
export interface InternetOverviewDto {
  provider: InternetProviderDto; executors: InternetExecutorDto[]
  capabilities: InternetCapabilityDto[]; summary: InternetOverviewSummaryDto
}
export interface InternetWorkflowAvailableActionsDto {
  approve: boolean; reject: boolean; cancel: boolean; retry: boolean; compensate: boolean
}
export interface InternetWorkflowSummaryDto {
  id: string; state: InternetWorkflowState; version: number; attempt: number; lastErrorCode: string | null
  availableActions: InternetWorkflowAvailableActionsDto; createdAt: string; updatedAt: string; completedAt: string | null
}
export interface InternetPolicyDecisionDto { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[] }
export interface InternetWorkflowStepDto {
  kind: string; state: string; attempt: number; lastErrorCode: string | null; updatedAt: string
}
export interface InternetWorkflowDetailDto extends InternetWorkflowSummaryDto {
  capabilityId: InternetCapabilityId; policyDecision: InternetPolicyDecisionDto | null; steps: InternetWorkflowStepDto[]
}
export interface InternetVideoDto {
  bvid: string; title: string; author: string; publishedAt: string | null
  durationSeconds: number | null; viewCount: number | null; canonicalUrl: string
}
export interface InternetSearchResultDto {
  schemaVersion: 1; provider: 'bilibili'; profile: string; operation: 'search'; query: string
  status: 'succeeded' | 'partial'; videos: InternetVideoDto[]; totalCount: number; omittedCount: number
}
export interface InternetInspectResultDto {
  schemaVersion: 1; provider: 'bilibili'; profile: string; operation: 'inspect'; status: 'succeeded'
  video: InternetVideoDto; description: string; tags: string[]
}
export type InternetResultDto = InternetSearchResultDto | InternetInspectResultDto
export type InternetSemanticInputDto = { query: string; limit: number; page: number; order: InternetSearchOrder }
  | { bvid: string }
export interface InternetReceiptDto {
  workflowId: string; intentId: string; capabilityId: InternetCapabilityId; provider: 'bilibili'; profile: string
  executorType: InternetExecutorType; environment: 'sandbox' | 'production'; operation: 'search' | 'inspect'
  input: InternetSemanticInputDto; safeToReplay: boolean; status: InternetReceiptStatus; result: InternetResultDto | null
  resultDigest: string | null; errorCode: string | null; version: number; createdAt: string
  updatedAt: string; completedAt: string | null
}
export interface InternetEvidenceDto {
  ordinal: number; stage: 'provider_read' | 'navigation' | 'snapshot' | 'verification'
  evidenceDigest: string | null; observedAt: string
}
export interface InternetReceiptDetailDto { receipt: InternetReceiptDto; evidence: InternetEvidenceDto[] }
export interface InternetActionResponseDto {
  intent: { id: string; capabilityId: InternetCapabilityId }; policyDecision: InternetPolicyDecisionDto
  workflow: InternetWorkflowSummaryDto
}
export type InternetSearchOrder = 'relevance' | 'newest' | 'most_viewed'
export interface SearchBilibiliInput {
  query: string; limit?: number; page?: number; order?: InternetSearchOrder; idempotencyKey: string
}
export interface InspectBilibiliInput { bvid: string; idempotencyKey: string }
export interface InternetReceiptQuery { status?: InternetReceiptStatus; limit?: number }

const BASE = '/api/hermes/internet-execution'
const id = (value: string) => encodeURIComponent(value)
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
function withQuery(path: string, entries: Array<[string, unknown]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined) params.set(key, String(value))
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function fetchInternetOverview(): Promise<InternetOverviewDto> { return request(`${BASE}/overview`) }
export function searchBilibiliVideos(input: SearchBilibiliInput): Promise<InternetActionResponseDto> {
  return request(`${BASE}/bilibili/search`, post(input))
}
export function inspectBilibiliVideo(input: InspectBilibiliInput): Promise<InternetActionResponseDto> {
  return request(`${BASE}/bilibili/inspect`, post(input))
}
export async function fetchInternetReceipts(query: InternetReceiptQuery = {}): Promise<InternetReceiptDto[]> {
  return (await request<{ receipts: InternetReceiptDto[] }>(withQuery(`${BASE}/receipts`, [
    ['status', query.status], ['limit', query.limit],
  ]))).receipts
}
export function fetchInternetReceipt(workflowId: string): Promise<InternetReceiptDetailDto> {
  return request(`${BASE}/receipts/${id(workflowId)}`)
}
export async function fetchInternetWorkflow(workflowId: string): Promise<InternetWorkflowDetailDto> {
  return (await request<{ workflow: InternetWorkflowDetailDto }>(`${BASE}/workflows/${id(workflowId)}`)).workflow
}
