export const MEMORY_SCOPES = ['session', 'workspace', 'user', 'global'] as const
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

export type MemoryScope = typeof MEMORY_SCOPES[number]
export type MemoryNodeType = typeof MEMORY_NODE_TYPES[number]
export type MemoryNodeStatus = typeof MEMORY_NODE_STATUSES[number]
export type MemoryMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface MemoryMessage {
  id: string
  sessionId: string
  parentId?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
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
  sessionId?: string
  workspaceId?: string
  userId?: string
  scope: MemoryScope
  domain: string
  categoryPath: string[]
  type: MemoryNodeType
  key?: string
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
  workspaceId?: string
  userId?: string
  actor: string
  reason: string
  payload?: Record<string, unknown>
  createdAt: string
}

export interface MemoryQuery {
  userId?: string
  workspaceId?: string
  sessionId?: string
  scopes?: MemoryScope[]
  domain?: string
  categoryPathPrefix?: string[]
  types?: MemoryNodeType[]
  key?: string
  valueJson?: unknown
  tags?: string[]
  entities?: string[]
  queryText?: string
  includeExpired?: boolean
  limit?: number
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
  workspaceId?: string
  userId?: string
}

export interface MemoryExtractionInput extends MemoryRuntimeIdentity {
  previousSummary?: MemorySummary
  messages: MemoryMessage[]
}

export interface MemoryExtractionOperation {
  operation: 'create' | 'update' | 'supersede' | 'expire' | 'ignore'
  targetId?: string
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
  targetId?: string
  node: Partial<MemoryNode>
  reason: string
  actor?: string
  explicitUserIntent?: boolean
  identity?: Partial<MemoryRuntimeIdentity>
}

export interface MemoryProposeUpdateResult {
  accepted: boolean
  nodeId?: string
  reason?: string
}

export interface MemoryForgetInput {
  id?: string
  scope?: MemoryScope
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
  mode: 'soft' | 'hard'
  requiresConfirmation?: boolean
  reason?: string
}

export interface MemorySessionState {
  sessionId: string
  lastExtractedMessageId?: string
  lastSummaryMessageId?: string
  updatedAt: string
}

export interface MemoryStore {
  appendMessage(message: MemoryMessage): Promise<void>
  listRecentMessages(input: { sessionId: string; limit: number }): Promise<MemoryMessage[]>
  listMessagesAfter(input: { sessionId: string; messageId?: string; limit?: number }): Promise<MemoryMessage[]>
  appendSummary(summary: MemorySummary): Promise<void>
  getLatestSummary(input: { sessionId: string }): Promise<MemorySummary | undefined>
  getNode(id: string): Promise<MemoryNode | undefined>
  upsertNode(node: MemoryNode, audit?: Omit<MemoryAuditEvent, 'id' | 'nodeId' | 'createdAt'>): Promise<void>
  supersedeNode(input: { oldNodeId: string; newNode: MemoryNode; reason: string; actor: string }): Promise<void>
  updateNodeStatus(input: { nodeId: string; status: MemoryNodeStatus; reason: string; actor: string }): Promise<boolean>
  deleteNode(input: { nodeId: string; mode: 'soft' | 'hard'; reason: string; actor: string }): Promise<boolean>
  queryNodes(query: MemoryQuery): Promise<MemoryNode[]>
  appendAuditEvent(event: MemoryAuditEvent): Promise<void>
  getSessionState(sessionId: string): Promise<MemorySessionState | undefined>
  setSessionState(state: MemorySessionState): Promise<void>
  close(): void
}
