import { request } from '@/api/client'

export type LifeSourceKind = 'calendar' | 'contacts' | 'travel' | 'music' | 'games' | 'subscriptions'
export type LifeMode = 'observe' | 'shadow' | 'live'
export type LifeAccountHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'revoked'
export type LifeOptionKind = 'travel' | 'video' | 'music' | 'game'
export type LifePlanState = 'proposed' | 'reserved' | 'superseded' | 'completed' | 'expired'
export type LifeWorkflowState = 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating' | 'succeeded' | 'denied' | 'cancelled'
  | 'failed' | 'dead_letter' | 'compensated'
export type LifeHoldState = 'requested' | 'submitting' | 'confirmed' | 'cancel_requested' | 'cancelling'
  | 'cancelled' | 'lookup_required' | 'waiting_user' | 'failed'
export type LifeCancellationState = 'requested' | 'submitting' | 'processing' | 'cancelled' | 'rejected'
  | 'lookup_required' | 'waiting_user' | 'failed'

export interface LifeMoneyDto { currency: string; amountMinor: number }
export interface LifeWindowDto { startsAt: string; endsAt: string }
export interface LifeSourceDto {
  id: string; sourceKind: LifeSourceKind; mode: LifeMode; executorId: string | null; displayName: string
  health: LifeAccountHealth; enabled: boolean; policyEpoch: number; version: number
  createdAt: string; updatedAt: string; revokedAt: string | null
}
export interface LifeCommitmentDto {
  id: string; accountId: string; label: string; category: 'work' | 'personal' | 'health' | 'travel' | 'leisure' | 'other'
  startsAt: string; endsAt: string; allDay: boolean; busy: boolean
  locationClass: 'remote' | 'home' | 'local' | 'out_of_area' | 'unknown'; participantAliasIds: string[]
  observedAt: string; expiresAt: string; sourceDigest: string
}
export interface LifeContactDto {
  id: string; accountId: string; alias: string; relationshipTags: string[]; availabilityTags: string[]
  observedAt: string; sourceDigest: string
}
export interface LifeOptionDto {
  id: string; accountId: string | null; kind: LifeOptionKind; source: string; title: string; categoryTags: string[]
  durationMinutes: number; exertion: 'low' | 'medium' | 'high'; screenBased: boolean
  locationClass: 'remote' | 'home' | 'local' | 'out_of_area' | 'unknown'; cost: LifeMoneyDto | null
  available: boolean; observedAt: string; expiresAt: string; sourceDigest: string
}
export interface LifeSubscriptionDto {
  id: string; accountId: string; serviceLabel: string; planLabel: string; recurringCost: LifeMoneyDto
  renewalAt: string; cancellationDeadline: string | null
  state: 'active' | 'trial' | 'paused' | 'cancel_pending' | 'cancelled' | 'expired'
  observedAt: string; sourceDigest: string; version: number
}
export interface LifeConstraintDto {
  id: string; subjectId: string; horizon: LifeWindowDto; timezone: string; freeWindows: LifeWindowDto[]
  commitmentIds: string[]; readiness: 'unknown' | 'low' | 'normal' | 'high'
  recovery: 'unknown' | 'poor' | 'fair' | 'good'; sleepDebt: 'unknown' | 'none' | 'moderate' | 'high'
  screenTimeUsedMinutes: number; screenTimeLimitMinutes: number; leisureTimeLimitMinutes: number
  budget: LifeMoneyDto; quietStartMinute: number; quietEndMinute: number; maxTravelRadiusKm: number
  excludedCategories: string[]; preferredCategories: string[]
  factRefs: Array<{ recordId: string; recordDigest: string; observedAt: string }>
  materialDigest: string; createdAt: string; expiresAt: string
}
export interface LifePlanCandidateDto {
  optionId: string; eligible: boolean; score: number | null; exclusionCodes: string[]; rationaleCodes: string[]
}
export interface LifePlanSessionDto extends LifeWindowDto {
  optionId: string; cost: LifeMoneyDto | null; rationaleCodes: string[]
}
export interface LifePlanDto {
  id: string; constraintSnapshotId: string; constraintDigest: string; candidates: LifePlanCandidateDto[]
  sessions: LifePlanSessionDto[]; totalMinutes: number; totalCost: LifeMoneyDto; planDigest: string
  state: LifePlanState; version: number; createdAt: string; updatedAt: string
}
export interface LifeHandoffDto {
  id: string; planRevisionId: string; optionId: string; kind: 'commerce' | 'internet' | 'android'
  targetCapabilityId: string; materialDigest: string; state: 'proposed' | 'accepted' | 'expired' | 'cancelled'
  version: number; createdAt: string; updatedAt: string
}
export interface LifeCalendarHoldDto {
  id: string; workflowId: string; accountId: string; planRevisionId: string; planDigest: string
  optionId: string; window: LifeWindowDto; receiptDigest: string | null; state: LifeHoldState
  policyEpoch: number; version: number; createdAt: string; updatedAt: string; completedAt: string | null
}
export interface LifeCancellationDto {
  id: string; workflowId: string; accountId: string; subscriptionId: string; subscriptionDigest: string
  reasonCode: string; receiptDigest: string | null; state: LifeCancellationState; policyEpoch: number
  version: number; createdAt: string; updatedAt: string; completedAt: string | null
}
export interface LifeAvailableActionsDto {
  approve: boolean; reject: boolean; cancel: boolean; retry: boolean; compensate: boolean
}
export interface LifeWorkflowDto {
  id: string; capabilityId: string; state: LifeWorkflowState; version: number; attempt: number
  lastErrorCode: string | null; createdAt: string; updatedAt: string; completedAt: string | null
  availableActions: LifeAvailableActionsDto
}
export interface LifeWorkflowDetailDto extends LifeWorkflowDto {
  policyDecision: { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[] } | null
  steps: Array<{ kind: string; state: string; attempt: number; lastErrorCode: string | null; updatedAt: string }>
}
export interface LifeTakeoverDto {
  workflowId: string; capabilityId: string; reasonCode: string; state: 'waiting_user'; requestedAt: string
}
export interface LifeActivationReviewDto {
  id: string; accountId: string; fromMode: LifeMode; toMode: LifeMode; actorUserId: string
  shadowEvidenceDigest: string | null; limitsDigest: string; approved: boolean; createdAt: string
}
export interface LifeRuntimeDto {
  configuredAccountCount: number; sourceExecutorEnabled: boolean; shadowExecutorEnabled: boolean
  liveExecutorEnabled: boolean; authorizedTargetCount: number; emergencyStopped: boolean
}
export interface LifeOverviewDto {
  runtime: LifeRuntimeDto; accounts: LifeSourceDto[]; plans: LifePlanDto[]; workflows: LifeWorkflowDto[]
  holds: LifeCalendarHoldDto[]; cancellations: LifeCancellationDto[]; takeovers: LifeTakeoverDto[]
  summary: { accountCount: number; liveAccountCount: number; activePlanCount: number
    activeWorkflowCount: number; pendingTakeoverCount: number }
}
export interface LifeActionResponseDto {
  intent: { id: string; capabilityId: string }
  policyDecision: { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[] }
  workflow: LifeWorkflowDto
}
export interface LifeActionInput { idempotencyKey: string; rationale: string }
export interface SyncLifeSourceInput extends LifeActionInput { accountId: string; cursor: string | null; limit: number }
export interface CreateLifeConstraintInput {
  subjectId?: string; horizon: LifeWindowDto; timezone: string
  policy: { budget: LifeMoneyDto; screenTimeLimitMinutes: number; leisureTimeLimitMinutes: number
    quietStartMinute: number; quietEndMinute: number; maxTravelRadiusKm: number
    excludedCategories: string[]; preferredCategories: string[] }
  createdAt: string; expiresAt: string; healthFreshnessMs?: number; screenTimeFreshnessMs?: number
  useTwinPreferences?: boolean
}
export interface CreateLifePlanInput {
  constraintSnapshotId: string; activeAt: string; maxOptions?: number; maxSessions?: number
}
export interface VerifyLifePlanInput extends LifeActionInput { planRevisionId: string; activeAt: string }
export interface CreateLifeHoldInput extends LifeActionInput {
  accountId: string; planRevisionId: string; optionId: string; providerRequestId: string
}
export interface CancelLifeHoldInput extends LifeActionInput {
  holdId: string; providerRequestId: string; reasonCode: string
}
export interface CancelLifeSubscriptionInput extends LifeActionInput {
  subscriptionId: string; providerRequestId: string; reasonCode: string
}
export interface LifeActivationLimitsInput { currency: string; calendarIds: string[]; subscriptionIds: string[] }

const BASE = '/api/hermes/life'
const id = (value: string) => encodeURIComponent(value)
const write = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) })
function withQuery(path: string, entries: Array<[string, unknown]>): string {
  const query = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  return query.size ? `${path}?${query}` : path
}
async function list<T>(path: string, field: string): Promise<T[]> {
  return (await request<Record<string, T[]>>(path))[field] ?? []
}

export function fetchLifeOverview(): Promise<LifeOverviewDto> { return request(`${BASE}/overview`) }
export function fetchLifeSources(): Promise<LifeSourceDto[]> {
  return list(withQuery(`${BASE}/sources`, [['limit', 100]]), 'sources')
}
export function fetchLifeCommitments(accountId?: string): Promise<LifeCommitmentDto[]> {
  return list(withQuery(`${BASE}/commitments`, [['accountId', accountId], ['limit', 100]]), 'commitments')
}
export function fetchLifeContacts(accountId?: string): Promise<LifeContactDto[]> {
  return list(withQuery(`${BASE}/contacts`, [['accountId', accountId], ['limit', 100]]), 'contacts')
}
export function fetchLifeOptions(kind?: LifeOptionKind): Promise<LifeOptionDto[]> {
  return list(withQuery(`${BASE}/options`, [['kind', kind], ['activeAt', new Date().toISOString()], ['limit', 100]]), 'options')
}
export function fetchLifeSubscriptions(accountId?: string): Promise<LifeSubscriptionDto[]> {
  return list(withQuery(`${BASE}/subscriptions`, [['accountId', accountId], ['limit', 100]]), 'subscriptions')
}
export function fetchLifeConstraints(): Promise<LifeConstraintDto[]> {
  return list(withQuery(`${BASE}/constraints`, [['limit', 100]]), 'constraints')
}
export function fetchLifePlans(state?: LifePlanState): Promise<LifePlanDto[]> {
  return list(withQuery(`${BASE}/plans`, [['state', state], ['limit', 100]]), 'plans')
}
export function fetchLifeHandoffs(planRevisionId?: string): Promise<LifeHandoffDto[]> {
  return list(withQuery(`${BASE}/handoffs`, [['planRevisionId', planRevisionId], ['limit', 100]]), 'handoffs')
}
export function fetchLifeHolds(accountId?: string): Promise<LifeCalendarHoldDto[]> {
  return list(withQuery(`${BASE}/holds`, [['accountId', accountId], ['limit', 100]]), 'holds')
}
export function fetchLifeCancellations(accountId?: string): Promise<LifeCancellationDto[]> {
  return list(withQuery(`${BASE}/cancellations`, [['accountId', accountId], ['limit', 100]]), 'cancellations')
}
export function fetchLifeWorkflows(): Promise<LifeWorkflowDto[]> {
  return list(withQuery(`${BASE}/workflows`, [['limit', 100]]), 'workflows')
}
export async function fetchLifeWorkflow(workflowId: string): Promise<LifeWorkflowDetailDto> {
  return (await request<{ workflow: LifeWorkflowDetailDto }>(`${BASE}/workflows/${id(workflowId)}`)).workflow
}
export function fetchLifeTakeovers(): Promise<LifeTakeoverDto[]> {
  return list(withQuery(`${BASE}/takeovers`, [['limit', 100]]), 'takeovers')
}
export function fetchLifeActivationReviews(accountId: string): Promise<LifeActivationReviewDto[]> {
  return list(withQuery(`${BASE}/sources/${id(accountId)}/activation-reviews`, [['limit', 100]]), 'reviews')
}

export async function createLifeSource(input: { id: string; sourceKind: LifeSourceKind; mode: 'observe' | 'shadow'
  displayName: string; enabled?: boolean }): Promise<LifeSourceDto> {
  return (await request<{ source: LifeSourceDto }>(`${BASE}/sources`, write(input))).source
}
export function syncLifeSource(input: SyncLifeSourceInput): Promise<LifeActionResponseDto> {
  return request(`${BASE}/sources/sync`, write(input))
}
export async function createLifeConstraint(input: CreateLifeConstraintInput): Promise<LifeConstraintDto> {
  return (await request<{ constraint: LifeConstraintDto }>(`${BASE}/constraints`, write(input))).constraint
}
export function createLifePlan(input: CreateLifePlanInput): Promise<{ plan: LifePlanDto; handoffs: LifeHandoffDto[] }> {
  return request(`${BASE}/plans`, write(input))
}
export function verifyLifePlan(input: VerifyLifePlanInput): Promise<LifeActionResponseDto> {
  return request(`${BASE}/plans/verify`, write(input))
}
export function createLifeHold(input: CreateLifeHoldInput): Promise<LifeActionResponseDto> {
  return request(`${BASE}/holds`, write(input))
}
export function cancelLifeHold(input: CancelLifeHoldInput): Promise<LifeActionResponseDto> {
  return request(`${BASE}/holds/cancel`, write(input))
}
export function cancelLifeSubscription(input: CancelLifeSubscriptionInput): Promise<LifeActionResponseDto> {
  return request(`${BASE}/subscriptions/cancel`, write(input))
}
export async function updateLifeSourceHealth(accountId: string, health: Exclude<LifeAccountHealth, 'revoked'>,
  expectedVersion: number): Promise<LifeSourceDto> {
  return (await request<{ source: LifeSourceDto }>(`${BASE}/sources/${id(accountId)}/health`,
    write({ health, expectedVersion }, 'PUT'))).source
}
export function activateLifeSource(accountId: string, toMode: LifeMode, limits: LifeActivationLimitsInput):
Promise<{ source: LifeSourceDto; review: LifeActivationReviewDto }> {
  return request(`${BASE}/sources/${id(accountId)}/activate`, write({ toMode, limits }))
}
export async function revokeLifeSource(accountId: string, expectedVersion: number): Promise<LifeSourceDto> {
  return (await request<{ source: LifeSourceDto }>(`${BASE}/sources/${id(accountId)}/revoke`,
    write({ expectedVersion }))).source
}
export async function reviewLifeWorkflow(workflowId: string, action: 'approve' | 'reject', reason = ''):
Promise<LifeWorkflowDetailDto> {
  const body = action === 'approve' ? {} : { reason }
  return (await request<{ workflow: LifeWorkflowDetailDto }>(
    `/api/hermes/action-fabric/workflows/${id(workflowId)}/${action}`, write(body),
  )).workflow
}
