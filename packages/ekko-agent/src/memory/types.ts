export const MEMORY_NODE_TYPES = [
  'preference',
  'fact',
  'decision',
  'task',
  'recipe',
  'skill',
  'constraint',
  'correction',
] as const
export const MEMORY_NODE_STATUSES = ['active', 'superseded', 'expired', 'deleted'] as const
export const MEMORY_SCOPE_TYPES = ['profile', 'context', 'session'] as const
export const MEMORY_KINDS = [
  'interaction_contract',
  'profile_name',
  'home_location',
  'occupation',
  'timezone_preference',
  'language_preference',
  'accessibility_need',
  'communication_preference',
  'general_preference',
  'workflow_preference',
  'tool_preference',
  'personal_relationship',
  'habit_routine',
  'environment_fact',
  'project_context',
  'long_term_goal',
  'durable_decision',
  'hard_constraint',
  'food_avoidance',
  'custom_fact',
] as const

export type MemoryNodeType = typeof MEMORY_NODE_TYPES[number]
export type MemoryNodeStatus = typeof MEMORY_NODE_STATUSES[number]
export type MemoryKind = typeof MEMORY_KINDS[number]
export type MemoryScopeType = typeof MEMORY_SCOPE_TYPES[number]
export type MemoryMessageRole = 'system' | 'user' | 'assistant' | 'tool'
export type MemoryReviewPolicy = 'automatic' | 'explicit-only'

export type MemoryScope =
  | { type: 'profile' }
  | { type: 'context'; namespace: string; id: string }
  | { type: 'session'; id: string }

/** Host-stamped provenance. Ekko stores it as opaque metadata and never interprets host-specific names. */
export interface MemoryOrigin {
  host?: string
  namespace?: string
  contextId?: string
}

export interface MemoryMessage {
  id: string
  sessionId: string
  parentId?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface MemoryEvidenceMessageInput {
  id?: string
  role: Extract<MemoryMessageRole, 'user' | 'assistant'>
  content: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export interface MemorySummary {
  id: string
  sessionId: string
  parentSummaryId?: string
  fromMessageId: string
  toMessageId: string
  summary: string
  currentGoal?: string
  constraints: string[]
  preferences: string[]
  decisions: string[]
  completedWork: string[]
  pendingWork: string[]
  knownIssues: string[]
  createdAt: string
}

export interface MemoryNode {
  id: string
  parentId?: string
  supersedesId?: string
  profileId: string
  /** Defaults to profile scope for nodes created before scoped memory existed. */
  scope?: MemoryScope
  origin?: MemoryOrigin
  domain: string
  categoryPath: string[]
  type: MemoryNodeType
  key: string
  revision: number
  valueJson?: unknown
  title: string
  content: string
  status: MemoryNodeStatus
  confidence: number
  importance: number
  tags: string[]
  entities: string[]
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}

export interface MemoryAuditEvent {
  id: string
  eventType: 'create' | 'update' | 'supersede' | 'expire' | 'delete' | 'extract' | 'summary'
  nodeId?: string
  sessionId?: string
  profileId: string
  actor: string
  reason: string
  payload?: Record<string, unknown>
  createdAt: string
}

export interface MemoryQuery {
  profileId?: string
  scopes?: MemoryScope[]
  domain?: string
  categoryPathPrefix?: string[]
  types?: MemoryNodeType[]
  kinds?: MemoryKind[]
  key?: string
  valueJson?: unknown
  tags?: string[]
  entities?: string[]
  queryText?: string
  includeExpired?: boolean
  statuses?: MemoryNodeStatus[]
  limit?: number
  offset?: number
}

export interface MemoryAuditQuery {
  profileId?: string
  nodeId?: string
  sessionId?: string
  eventTypes?: MemoryAuditEvent['eventType'][]
  actor?: string
  limit?: number
  offset?: number
}

export type MemoryOmissionReason =
  | 'expired'
  | 'superseded'
  | 'low_confidence'
  | 'conflict_lost'
  | 'over_limit'

export interface MemoryQueryResult {
  exact: MemoryNode[]
  relevant: MemoryNode[]
  omitted: Array<{ nodeId: string; reason: MemoryOmissionReason }>
}

export interface MemoryContextDiagnostics {
  enabled: boolean
  storeStatus: 'ok' | 'disabled' | 'degraded'
  warnings: string[]
  retrievedNodeCount: number
  omittedNodeCount: number
  tokenBudget?: number
  usedTokens?: number
}

export interface MemoryContext {
  latestSummary?: MemorySummary
  recentMessages: MemoryMessage[]
  activeTasks: MemoryNode[]
  relevantNodes: MemoryNode[]
  constraints: MemoryNode[]
  preferences: MemoryNode[]
  usedMemoryIds: string[]
  diagnostics: MemoryContextDiagnostics
}

export interface MemoryRuntimeIdentity {
  sessionId: string
  profileId?: string
  origin?: MemoryOrigin
  recallScopes?: MemoryScope[]
  writeScopes?: MemoryScope[]
  defaultWriteScope?: MemoryScope
}

export interface MemoryExtractionInput extends MemoryRuntimeIdentity {
  previousSummary?: MemorySummary
  messages: MemoryMessage[]
  reviewRequest?: MemoryReviewJobRequest
  signal?: AbortSignal
}

export interface MemoryExtractionOperation {
  operation: 'create' | 'update' | 'supersede' | 'expire' | 'ignore'
  kind?: MemoryKind
  itemKey?: string
  scope?: MemoryScope
  targetId?: string
  expectedRevision?: number
  node: Partial<MemoryNode>
  reason: string
  explicitUserIntent?: boolean
}

export interface MemoryExtraction {
  summaryPatch?: string
  currentGoal?: string
  constraints?: string[]
  preferences?: string[]
  decisions?: string[]
  completedWork?: string[]
  pendingWork?: string[]
  knownIssues?: string[]
  nodes: MemoryExtractionOperation[]
  forceSummary?: boolean
  fallbackReason?: string
}

export interface MemoryExtractor {
  extract(input: MemoryExtractionInput): Promise<MemoryExtraction>
}

export interface MemoryProposeUpdateInput {
  operation: 'create' | 'update' | 'supersede' | 'expire' | 'delete'
  kind?: MemoryKind
  itemKey?: string
  scope?: MemoryScope
  targetId?: string
  expectedRevision?: number
  valuePatch?: Record<string, unknown>
  unsetValueFields?: string[]
  node: Partial<MemoryNode>
  reason: string
  actor?: string
  explicitUserIntent?: boolean
  identity?: Partial<MemoryRuntimeIdentity>
}

export interface MemoryProposeUpdateResult {
  accepted: boolean
  nodeId?: string
  action?: 'created' | 'updated' | 'noop' | 'expired' | 'deleted'
  node?: MemoryNode
  reason?: string
}

export interface MemoryCreateInput {
  kind: MemoryKind
  itemKey?: string
  node: Partial<MemoryNode>
  reason: string
  actor?: string
  explicitUserIntent?: boolean
  identity?: Partial<MemoryRuntimeIdentity>
}

export interface MemoryUpdateInput {
  node?: Partial<MemoryNode>
  valuePatch?: Record<string, unknown>
  unsetValueFields?: string[]
  reason: string
  actor?: string
  expectedRevision: number
  explicitUserIntent?: boolean
  identity?: Partial<MemoryRuntimeIdentity>
}

export interface MemoryExpireInput {
  reason: string
  actor?: string
  expectedRevision: number
  identity?: Partial<MemoryRuntimeIdentity>
}

export interface MemoryDeleteInput extends MemoryExpireInput {
  mode?: 'soft' | 'hard'
  confirmed?: boolean
}

export interface MemoryMessageListInput {
  sessionId: string
  afterMessageId?: string
  limit?: number
}

export interface MemoryForgetInput {
  all?: boolean
  targets?: Array<{ id: string; expectedRevision: number }>
  id?: string
  expectedRevision?: number
  domain?: string
  categoryPathPrefix?: string[]
  type?: MemoryNodeType
  key?: string
  valueJson?: unknown
  mode?: 'soft' | 'hard'
  reason: string
  actor?: string
  identity?: Partial<MemoryRuntimeIdentity>
  confirmed?: boolean
}

export interface MemoryForgetResult {
  deletedIds: string[]
  deletedMemories?: MemoryNode[]
  mode: 'soft' | 'hard'
  requiresConfirmation?: boolean
  reason?: string
}

export interface MemorySessionState {
  sessionId: string
  /** @deprecated Kept for stores created before review and summary cursors were split. */
  lastExtractedMessageId?: string
  lastReviewedMessageId?: string
  lastSummaryMessageId?: string
  updatedAt: string
}

export const MEMORY_REVIEW_JOB_STATUSES = [
  'pending',
  'running',
  'retry',
  'waiting_for_model',
  'needs_confirmation',
  'completed',
] as const

export type MemoryReviewJobStatus = typeof MEMORY_REVIEW_JOB_STATUSES[number]
export type MemoryReviewJobTrigger = 'review' | 'forget' | 'periodic'

export interface MemoryReviewJobRequest {
  trigger: MemoryReviewJobTrigger
  forget?: Omit<MemoryForgetInput, 'identity' | 'actor'>
  /** Set only after the Studio user explicitly asks this persisted job to run now. */
  userConfirmed?: boolean
}

export interface MemoryReviewJob {
  id: string
  profileId: string
  sessionId: string
  throughMessageId: string
  identity: MemoryRuntimeIdentity
  request: MemoryReviewJobRequest
  preferredProvider?: string
  preferredModel?: string
  status: MemoryReviewJobStatus
  attempt: number
  nextAttemptAt?: string
  lockedAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface MemoryReviewJobCreateInput {
  id: string
  profileId: string
  sessionId: string
  throughMessageId: string
  identity: MemoryRuntimeIdentity
  request: MemoryReviewJobRequest
  preferredProvider?: string
  preferredModel?: string
  createdAt: string
}

export interface MemoryReviewJobUpdateInput {
  status: MemoryReviewJobStatus
  nextAttemptAt?: string
  lockedAt?: string
  lastError?: string
  completedAt?: string
  incrementAttempt?: boolean
}

export interface MemoryReviewJobListInput {
  profileId: string
  statuses?: MemoryReviewJobStatus[]
  limit?: number
  offset?: number
}

export interface MemoryReviewQueueStatus {
  reviewing: boolean
  activeJobs: number
  pending: number
  running: number
  retry: number
  waitingForModel: number
  needsConfirmation: number
  latestCompletedAt?: string
}

export interface MemoryStore {
  appendMessage(message: MemoryMessage): Promise<void>
  listRecentMessages(input: { sessionId: string; limit: number }): Promise<MemoryMessage[]>
  listMessagesAfter(input: {
    sessionId: string
    messageId?: string
    throughMessageId?: string
    limit?: number
  }): Promise<MemoryMessage[]>
  appendSummary(summary: MemorySummary): Promise<void>
  getLatestSummary(input: { sessionId: string }): Promise<MemorySummary | undefined>
  getNode(id: string): Promise<MemoryNode | undefined>
  upsertNode(node: MemoryNode, audit?: Omit<MemoryAuditEvent, 'id' | 'nodeId' | 'createdAt'>): Promise<void>
  supersedeNode(input: { oldNodeId: string; newNode: MemoryNode; reason: string; actor: string; sessionId?: string }): Promise<void>
  updateNodeStatus(input: { nodeId: string; status: MemoryNodeStatus; reason: string; actor: string; expectedRevision?: number; sessionId?: string }): Promise<boolean>
  deleteNode(input: { nodeId: string; mode: 'soft' | 'hard'; reason: string; actor: string; expectedRevision?: number; sessionId?: string }): Promise<boolean>
  queryNodes(query: MemoryQuery): Promise<MemoryNode[]>
  appendAuditEvent(event: MemoryAuditEvent): Promise<void>
  listAuditEvents(query?: MemoryAuditQuery): Promise<MemoryAuditEvent[]>
  getSessionState(sessionId: string): Promise<MemorySessionState | undefined>
  setSessionState(state: MemorySessionState): Promise<void>
  enqueueReviewJob(input: MemoryReviewJobCreateInput): Promise<MemoryReviewJob>
  getReviewJob(id: string): Promise<MemoryReviewJob | undefined>
  listReviewJobs(input: MemoryReviewJobListInput): Promise<MemoryReviewJob[]>
  activateReviewJob(input: {
    id: string
    profileId: string
    now: string
    confirmedByUser?: boolean
  }): Promise<MemoryReviewJob | undefined>
  claimNextReviewJob(input: {
    profileId: string
    now: string
    staleBefore: string
  }): Promise<MemoryReviewJob | undefined>
  updateReviewJob(id: string, input: MemoryReviewJobUpdateInput): Promise<void>
  requeueStaleReviewJobs(input: {
    profileId?: string
    now: string
    staleBefore: string
  }): Promise<number>
  activateReviewJobs(input: { profileId?: string; now: string }): Promise<void>
  listPendingReviewProfiles(input: { now: string; staleBefore: string }): Promise<string[]>
  getReviewQueueStatus(profileId: string): Promise<MemoryReviewQueueStatus>
  close(): void
}
