/** @openapi-schema-source */
import { request } from '@/api/client'

export type ActionRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'
export type ActionWorkflowState = 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating' | 'succeeded' | 'denied' | 'cancelled'
  | 'failed' | 'dead_letter' | 'compensated'
export type ActionExecutorType = 'simulator' | 'internal' | 'connector'
export type ActionExecutorEnvironment = 'simulator' | 'internal' | 'sandbox' | 'production'
export type ActionExecutorHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
export type ActionAuditAggregateType = 'capability' | 'executor' | 'intent' | 'workflow' | 'control' | 'system'
export type ActionJsonValue = null | boolean | number | string | ActionJsonValue[] | ActionJsonObject
export interface ActionJsonObject { [key: string]: ActionJsonValue }

export interface ActionMoney { currency: string | null; amountMinor: number }
export interface ActionEstimatedCost { currency: string | null; estimatedMinor: number }
export interface ActionCapabilityDto {
  id: string; version: number; domain: string; verb: string; description: string; inputSchema: ActionJsonValue
  outputSchema: ActionJsonValue; risk: ActionRisk; sideEffect: boolean; idempotency: 'none' | 'supported' | 'required'
  reversible: boolean; compensationCapabilityId: string | null; verificationStrategy: string
  authentication: string[]; targetRestrictions: string[]; cost: ActionEstimatedCost; enabled: boolean
  createdAt: string; updatedAt: string
}
export interface ActionExecutorDto {
  id: string; type: ActionExecutorType; name: string; environment: ActionExecutorEnvironment
  health: ActionExecutorHealth; enabled: boolean; policyVersion: number; createdAt: string; updatedAt: string
}
export interface ActionIntentDto {
  id: string; capabilityId: string; capabilityVersion: number; requestedByRoleId: string; requestedByUserId: string
  idempotencyKey: string; goal: string; target: ActionJsonObject; input: ActionJsonObject; constraints: ActionJsonObject
  rationale: string; expectedCost?: ActionMoney; sanitizedSummary: ActionJsonValue; createdAt: string; updatedAt: string
}
export interface ActionEvidenceDto { kind: string; summary: string; data: ActionJsonValue; capturedAt: string }
export interface ActionStepDto {
  id: string; workflowId: string; ordinal: number; kind: string; state: string; executorId: string | null
  input: ActionJsonValue; output: ActionJsonValue | null; evidence: ActionEvidenceDto[]; attempt: number
  lastErrorCode: string | null; createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null
}
export interface ActionPolicyDecisionDto {
  id: string; intentId: string; executorId: string | null; outcome: 'allow' | 'deny' | 'waiting_user'
  reasonCodes: string[]; policyVersion: number; sanitizedSummary: ActionJsonValue; budget: ActionMoney | null; createdAt: string
}
export type ActionWorkflowAction = 'approve' | 'reject' | 'cancel' | 'retry' | 'compensate'
export type ActionWorkflowAvailableActionsDto = { [action in ActionWorkflowAction]: boolean }
export interface ActionWorkflowSummaryDto {
  id: string; intentId: string; executorId: string | null; policyDecisionId: string | null
  compensationIntentId: string | null; state: ActionWorkflowState; version: number; attempt: number; maxAttempts: number
  leaseExpiresAt: string | null; retryAt: string | null; lastErrorCode: string | null; capabilityId: string; goal: string
  requestedByRoleId: string; requestedByUserId: string; createdAt: string; updatedAt: string; completedAt: string | null
  availableActions: ActionWorkflowAvailableActionsDto
}
export interface ActionWorkflowDetailDto extends ActionWorkflowSummaryDto {
  intent: ActionIntentDto; steps: ActionStepDto[]; policyDecision: ActionPolicyDecisionDto | null
}
export interface ActionAuditEventDto {
  id: string; sequence: number; eventType: string; actorUserId: string; aggregateType: ActionAuditAggregateType
  aggregateId: string; payload: ActionJsonValue; occurredAt: string; previousHash: string; hash: string
}
export interface ActionAuditVerificationDto {
  valid: boolean; checked: number; firstInvalidSequence: number | null; legacyValid?: boolean; needsMigration?: boolean
}
export interface ActionControlDto {
  level: 0 | 1 | 2 | 3; version: number; actorUserId: string | null; reason: string; updatedAt: string
}
export interface AuthError { error: string }
export interface ActionFabricError extends AuthError { code: string }
export interface ActionCapabilityListResponse { capabilities: ActionCapabilityDto[] }
export interface ActionExecutorListResponse { executors: ActionExecutorDto[] }
export interface ActionWorkflowListResponse { workflows: ActionWorkflowSummaryDto[]; nextCursor: string | null }
export interface ActionWorkflowResponse { workflow: ActionWorkflowDetailDto }
export interface ActionAuditListResponse { events: ActionAuditEventDto[]; nextAfterSequence: number | null }
export interface ActionAuditVerificationResponse { verification: ActionAuditVerificationDto }
export interface ActionControlResponse { control: ActionControlDto }

export interface CreateActionIntentInput {
  capabilityId: string; requestedByRoleId: string; idempotencyKey: string; goal: string
  target: ActionJsonObject; input: ActionJsonObject; constraints: ActionJsonObject; rationale: string
  expectedCost?: { currency: string; amountMinor: number }
  environments?: ActionExecutorEnvironment[]
}
export interface ActionIntentResultDto {
  intent: ActionIntentDto; policyDecision: ActionPolicyDecisionDto; workflow: ActionWorkflowDetailDto
}
export interface CapabilityQuery { domain?: string; risk?: ActionRisk; enabled?: boolean; limit?: number }
export interface ExecutorQuery {
  type?: ActionExecutorType; environment?: ActionExecutorEnvironment; health?: ActionExecutorHealth
  enabled?: boolean; limit?: number
}
export interface WorkflowQuery {
  state?: ActionWorkflowState; capabilityId?: string; requestedByRoleId?: string; requestedByUserId?: string
  cursor?: string; limit?: number
}
export interface AuditQuery {
  aggregateType?: ActionAuditAggregateType; aggregateId?: string; eventType?: string; afterSequence?: number; limit?: number
}
export interface EmergencyStopInput { level: 0 | 1 | 2 | 3; reason: string; expectedVersion: number }

const BASE = '/api/hermes/action-fabric'
function workflowPath(id: string): string { return `${BASE}/workflows/${encodeURIComponent(id)}` }
function withQuery(path: string, entries: Array<[string, unknown]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined) params.set(key, String(value))
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export async function fetchActionCapabilities(options: CapabilityQuery = {}): Promise<ActionCapabilityDto[]> {
  const response = await request<{ capabilities: ActionCapabilityDto[] }>(withQuery(`${BASE}/capabilities`, [
    ['domain', options.domain], ['risk', options.risk], ['enabled', options.enabled], ['limit', options.limit],
  ]))
  return response.capabilities
}
export async function fetchActionExecutors(options: ExecutorQuery = {}): Promise<ActionExecutorDto[]> {
  const response = await request<{ executors: ActionExecutorDto[] }>(withQuery(`${BASE}/executors`, [
    ['type', options.type], ['environment', options.environment], ['health', options.health],
    ['enabled', options.enabled], ['limit', options.limit],
  ]))
  return response.executors
}
export async function createActionIntent(input: CreateActionIntentInput): Promise<ActionIntentResultDto> {
  return request<ActionIntentResultDto>(`${BASE}/intents`, { method: 'POST', body: JSON.stringify(input) })
}
export async function fetchActionWorkflows(options: WorkflowQuery = {}): Promise<{
  workflows: ActionWorkflowSummaryDto[]; nextCursor: string | null
}> {
  return request(withQuery(`${BASE}/workflows`, [
    ['state', options.state], ['capabilityId', options.capabilityId], ['requestedByRoleId', options.requestedByRoleId],
    ['requestedByUserId', options.requestedByUserId], ['cursor', options.cursor], ['limit', options.limit],
  ]))
}
export async function fetchActionWorkflow(id: string): Promise<ActionWorkflowDetailDto> {
  const response = await request<{ workflow: ActionWorkflowDetailDto }>(workflowPath(id))
  return response.workflow
}
async function workflowMutation(id: string, action: string, body: Record<string, never> | { reason: string }) {
  const response = await request<{ workflow: ActionWorkflowDetailDto }>(`${workflowPath(id)}/${action}`, {
    method: 'POST', body: JSON.stringify(body),
  })
  return response.workflow
}
export function approveActionWorkflow(id: string) { return workflowMutation(id, 'approve', {}) }
export function rejectActionWorkflow(id: string, reason: string) { return workflowMutation(id, 'reject', { reason }) }
export function cancelActionWorkflow(id: string, reason: string) { return workflowMutation(id, 'cancel', { reason }) }
export function retryActionWorkflow(id: string) { return workflowMutation(id, 'retry', {}) }
export function compensateActionWorkflow(id: string, reason: string) { return workflowMutation(id, 'compensate', { reason }) }
export async function fetchActionAudit(options: AuditQuery = {}): Promise<{
  events: ActionAuditEventDto[]; nextAfterSequence: number | null
}> {
  return request(withQuery(`${BASE}/audit`, [
    ['aggregateType', options.aggregateType], ['aggregateId', options.aggregateId], ['eventType', options.eventType],
    ['afterSequence', options.afterSequence], ['limit', options.limit],
  ]))
}
export async function verifyActionAudit(): Promise<ActionAuditVerificationDto> {
  const response = await request<{ verification: ActionAuditVerificationDto }>(`${BASE}/audit/verify`)
  return response.verification
}
export async function fetchActionControl(): Promise<ActionControlDto> {
  const response = await request<{ control: ActionControlDto }>(`${BASE}/control`)
  return response.control
}
export async function updateActionEmergencyStop(input: EmergencyStopInput): Promise<ActionControlDto> {
  const response = await request<{ control: ActionControlDto }>(`${BASE}/control/emergency-stop`, {
    method: 'PUT', body: JSON.stringify(input),
  })
  return response.control
}
