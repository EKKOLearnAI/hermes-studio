export type FabricJsonObject = Record<string, unknown>

export type FabricRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'
export type FabricEnvironment = 'simulator' | 'internal' | 'sandbox' | 'production'
export type FabricPolicyOutcome = 'allow' | 'deny' | 'waiting_user'
export type FabricWorkflowState =
  | 'draft'
  | 'policy_check'
  | 'preparing'
  | 'executing'
  | 'verifying'
  | 'waiting_user'
  | 'retrying'
  | 'compensating'
  | 'succeeded'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'dead_letter'
  | 'compensated'

export type FabricIdempotency = 'required' | 'supported' | 'none'
export type FabricExecutorType = 'simulator' | 'internal'
export type FabricExecutorHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
export type FabricStepState = 'pending' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'compensated'
export type FabricOutboxStatus = 'pending' | 'published' | 'failed'
export type FabricBudgetStatus = 'reserved' | 'committed' | 'released'
export type FabricAuditAggregateType = 'capability' | 'executor' | 'intent' | 'workflow' | 'control' | 'system'

export interface FabricMoney {
  currency: string
  amountMinor: number
}

export interface FabricEstimatedCost {
  currency: string | null
  estimatedMinor: number
}

export interface FabricEvidence {
  kind: string
  summary: string
  data: FabricJsonObject
  capturedAt: string
}

export interface FabricCapability {
  id: string
  version: number
  domain: string
  verb: string
  description: string
  inputSchema: FabricJsonObject
  outputSchema: FabricJsonObject
  risk: FabricRisk
  sideEffect: boolean
  idempotency: FabricIdempotency
  reversible: boolean
  compensationCapabilityId: string | null
  verificationStrategy: string
  authentication: string[]
  targetRestrictions: string[]
  cost: FabricEstimatedCost
  contractDigest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface FabricExecutor {
  id: string
  type: FabricExecutorType
  name: string
  environment: FabricEnvironment
  health: FabricExecutorHealth
  healthDetails: FabricJsonObject
  configuration: FabricJsonObject
  enabled: boolean
  policyVersion: number
  createdAt: string
  updatedAt: string
}

export interface FabricExecutorCapability {
  executorId: string
  capabilityId: string
  capabilityVersion: number
  contractDigest: string
  createdAt: string
}

export interface ResolvedFabricExecutor {
  executor: FabricExecutor
  capability: FabricCapability
  binding: FabricExecutorCapability
  policyRevision: number
  policyEvaluationToken: string
}

export interface FabricActionIntentInput {
  capabilityId: string
  requestedByRoleId: string
  requestedByUserId: string
  idempotencyKey: string
  goal: string
  target: FabricJsonObject
  input: FabricJsonObject
  constraints: FabricJsonObject
  rationale: string
  expectedCost?: FabricMoney
}

export interface FabricActionIntent extends FabricActionIntentInput {
  id: string
  capabilityVersion: number
  materialInputDigest: string
  sanitizedSummary: FabricJsonObject
  createdAt: string
  updatedAt: string
}

export interface FabricWorkflow {
  id: string
  intentId: string
  executorId: string | null
  policyDecisionId: string | null
  compensationIntentId: string | null
  state: FabricWorkflowState
  version: number
  attempt: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  retryAt: string | null
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface FabricWorkflowSummary extends FabricWorkflow {
  capabilityId: string
  goal: string
  requestedByRoleId: string
  requestedByUserId: string
}

export interface FabricWorkflowDetail extends FabricWorkflowSummary {
  intent: FabricActionIntent
  steps: FabricStep[]
  policyDecision: FabricPolicyDecision | null
}

export interface FabricStep {
  id: string
  workflowId: string
  ordinal: number
  kind: string
  state: FabricStepState
  executionToken: string
  executorId: string | null
  input: FabricJsonObject
  output: FabricJsonObject | null
  evidence: FabricEvidence[]
  attempt: number
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface FabricPolicyDecision {
  id: string
  intentId: string
  executorId: string | null
  outcome: FabricPolicyOutcome
  reasonCodes: string[]
  policyVersion: number
  materialInputDigest: string
  policySnapshot: FabricJsonObject
  sanitizedSummary: FabricJsonObject
  budget: FabricMoney | null
  createdAt: string
}

export interface FabricBudgetReservation {
  id: string
  decisionId: string
  workflowId: string | null
  requestedByUserId: string
  requestedByRoleId: string
  ledgerDate: string
  money: FabricMoney
  status: FabricBudgetStatus
  createdAt: string
  updatedAt: string
}

export interface FabricAuditEventInput {
  eventType: string
  actorUserId: string
  aggregateType: FabricAuditAggregateType
  aggregateId: string
  payload: FabricJsonObject
  occurredAt?: string
}

export interface FabricAuditEvent extends Required<FabricAuditEventInput> {
  id: string
  sequence: number
  previousHash: string
  hash: string
}

export interface FabricControlState {
  level: 0 | 1 | 2 | 3
  version: number
  actorUserId: string | null
  reason: string
  updatedAt: string
}

export interface FabricOutboxRecord {
  id: string
  topic: string
  aggregateId: string
  payload: FabricJsonObject
  status: FabricOutboxStatus
  attempts: number
  availableAt: string
  lockedUntil: string | null
  createdAt: string
  publishedAt: string | null
}

export interface FabricCapabilityListOptions {
  domain?: string
  risk?: FabricRisk
  enabled?: boolean
  limit?: number
}

export interface FabricExecutorListOptions {
  type?: FabricExecutorType
  environment?: FabricEnvironment
  health?: FabricExecutorHealth
  enabled?: boolean
  limit?: number
}

export interface FabricWorkflowListOptions {
  state?: FabricWorkflowState
  capabilityId?: string
  requestedByRoleId?: string
  requestedByUserId?: string
  limit?: number
  cursor?: string
}

export interface FabricAuditListOptions {
  aggregateType?: FabricAuditAggregateType
  aggregateId?: string
  eventType?: string
  afterSequence?: number
  limit?: number
}

export interface FabricOutboxListOptions {
  status?: FabricOutboxStatus
  topic?: string
  limit?: number
}
