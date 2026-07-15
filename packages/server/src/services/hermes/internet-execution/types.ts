export const INTERNET_EXECUTOR_TYPES = ['mcp', 'browser'] as const
export type InternetExecutorType = typeof INTERNET_EXECUTOR_TYPES[number]

export const INTERNET_EXECUTION_ENVIRONMENTS = ['sandbox', 'production'] as const
export type InternetExecutionEnvironment = typeof INTERNET_EXECUTION_ENVIRONMENTS[number]

export const INTERNET_RECEIPT_STATUSES = [
  'prepared', 'executing', 'executed', 'verifying', 'verified', 'unknown', 'mismatch', 'failed', 'waiting_user',
] as const
export type InternetReceiptStatus = typeof INTERNET_RECEIPT_STATUSES[number]

export const INTERNET_CHECKPOINT_KINDS = [
  'mcp_call', 'browser_navigate', 'browser_snapshot', 'verification_read',
] as const
export type InternetCheckpointKind = typeof INTERNET_CHECKPOINT_KINDS[number]

export interface InternetExecutionReceipt {
  workflowId: string
  intentId: string
  materialDigest: string
  capabilityId: string
  provider: string
  profile: string
  executorId: string
  executorType: InternetExecutorType
  environment: InternetExecutionEnvironment
  operation: string
  request: Record<string, unknown>
  safeToReplay: boolean
  status: InternetReceiptStatus
  providerRequestId: string | null
  result: Record<string, unknown> | null
  errorCode: string | null
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface InternetExecutionCheckpoint {
  workflowId: string
  ordinal: number
  kind: InternetCheckpointKind
  publicUrl: string | null
  evidenceDigest: string | null
  details: Record<string, unknown>
  observedAt: string
  createdAt: string
}

export interface InternetReceiptPrepareInput {
  workflowId: string
  intentId: string
  materialDigest: string
  capabilityId: string
  provider: string
  profile: string
  executorId: string
  executorType: InternetExecutorType
  environment: InternetExecutionEnvironment
  operation: string
  request: Record<string, unknown>
  safeToReplay: boolean
}

export interface InternetReceiptTransitionInput {
  workflowId: string
  materialDigest: string
  expectedVersion: number
  status: Exclude<InternetReceiptStatus, 'prepared'>
  providerRequestId?: string | null
  result?: Record<string, unknown> | null
  errorCode?: string | null
}

export interface InternetCheckpointInput {
  workflowId: string
  materialDigest: string
  ordinal: number
  kind: InternetCheckpointKind
  publicUrl?: string | null
  evidenceDigest?: string | null
  details?: Record<string, unknown>
  observedAt: string
}

export interface InternetReceiptListOptions {
  status?: InternetReceiptStatus
  provider?: string
  profile?: string
  limit?: number
}

export interface InternetReceiptPrepareResult {
  disposition: 'created' | 'replayed'
  receipt: InternetExecutionReceipt
}

export interface InternetCheckpointResult {
  disposition: 'created' | 'replayed'
  checkpoint: InternetExecutionCheckpoint
}

export class InternetExecutionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InternetExecutionValidationError'
  }
}

export class InternetExecutionNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InternetExecutionNotFoundError'
  }
}

export class InternetExecutionIdentityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InternetExecutionIdentityConflictError'
  }
}

export class InternetExecutionVersionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InternetExecutionVersionConflictError'
  }
}
