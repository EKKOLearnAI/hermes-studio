import { createHash, randomUUID } from 'node:crypto'
import {
  buildMemoryContextPrompt,
  selectMemoryNodesByTokenBudget,
} from './context'
import {
  DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
  DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT,
  DEFAULT_MEMORY_REVIEW_EVERY_USER_MESSAGES,
  DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
} from '../config'
import { MemoryReviewNeedsConfirmationError, RuleBasedMemoryExtractor } from './extraction'
import { resolveMemoryQuery } from './retrieval'
import { canonicalizeMemoryDraft, memoryKindForCanonicalKey, normalizeMemoryNode } from './schema'
import { memoryScopeAllowed, normalizeMemoryScopes, PROFILE_MEMORY_SCOPE } from './scope'
import { stableJson } from './store'
import type {
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryContext,
  MemoryCreateInput,
  MemoryDeleteInput,
  MemoryExpireInput,
  MemoryExtraction,
  MemoryExtractor,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryMessage,
  MemoryMessageListInput,
  MemoryMessageRole,
  MemoryNode,
  MemoryProposeUpdateInput,
  MemoryProposeUpdateResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryReviewJob,
  MemoryReviewJobRequest,
  MemoryReviewJobStatus,
  MemoryReviewQueueStatus,
  MemoryRuntimeIdentity,
  MemoryReviewPolicy,
  MemoryStore,
  MemorySummary,
  MemorySessionState,
  MemoryUpdateInput,
} from './types'

const MEMORY_CANDIDATE_LIMIT = 500
const MAX_MEMORY_SEARCH_RESULTS = 50
const MEMORY_REVIEW_LEASE_MS = 5 * 60_000
const MEMORY_REVIEW_ATTEMPT_TIMEOUT_MS = 2 * 60_000
const MEMORY_REVIEW_RETRY_BASE_MS = 5_000
const MEMORY_REVIEW_RETRY_MAX_MS = 5 * 60_000
const MEMORY_REVIEW_MESSAGE_BATCH_LIMIT = 40
const ACTIVE_MEMORY_REVIEW_JOB_STATUSES: MemoryReviewJobStatus[] = [
  'pending',
  'running',
  'retry',
  'waiting_for_model',
  'needs_confirmation',
]
const ALWAYS_RECALLED_MEMORY_KINDS: NonNullable<MemoryQuery['kinds']> = [
  'interaction_contract',
  'language_preference',
  'accessibility_need',
  'communication_preference',
  'hard_constraint',
]

export interface MemoryServiceOptions {
  store?: MemoryStore
  extractor?: MemoryExtractor
  enabled?: boolean
  warning?: string
  recentMessageLimit?: number
  automaticRecallTokenBudget?: number
  searchResultLimit?: number
  /** @deprecated Use searchResultLimit. Automatic recall now uses automaticRecallTokenBudget. */
  nodeLimit?: number
  reviewEveryUserMessages?: number
  reviewAttemptTimeoutMs?: number
  /** @deprecated Use reviewEveryUserMessages. */
  summaryEveryMessages?: number
  reviewExtractorResolver?: MemoryReviewExtractorResolver
}

export interface MemoryReviewExtractorResolution {
  extractor: MemoryExtractor
  provider?: string
  model?: string
}

export type MemoryReviewExtractorResolver = (
  job: MemoryReviewJob,
) => Promise<MemoryReviewExtractorResolution | undefined>

export interface MemoryReviewScheduleInput {
  identity: MemoryRuntimeIdentity
  throughMessageId: string
  request: MemoryReviewJobRequest
  preferredProvider?: string
  preferredModel?: string
  extractor?: MemoryExtractor
}

export interface MemoryCaptureMessage {
  id?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export interface MemoryRunCompletionOptions {
  reviewPolicy?: MemoryReviewPolicy
  /** Force the current captured batch through review, subject to host review policy. */
  forceReview?: boolean
  /** The foreground tool already created the immediate review job for this evidence batch. */
  reviewAlreadyScheduled?: boolean
  preferredProvider?: string
  preferredModel?: string
  summaryExtractor?: MemoryExtractor
}

export class MemoryService {
  private readonly store?: MemoryStore
  private readonly extractor: MemoryExtractor
  private enabled: boolean
  private recentMessageLimit: number
  private automaticRecallTokenBudget: number
  private searchResultLimit: number
  private reviewEveryUserMessages: number
  private readonly reviewAttemptTimeoutMs: number
  private readonly reviewExtractorResolvers: MemoryReviewExtractorResolver[]
  private readonly warnings = new Set<string>()
  private readonly reviewWorkers = new Map<string, Promise<void>>()
  private readonly reviewWorkerWakeups = new Set<string>()
  private readonly reviewExtractors = new Map<string, MemoryExtractor>()
  private readonly profileReviewExtractors = new Map<string, MemoryReviewExtractorResolution>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryTimerDueAt = new Map<string, number>()
  private summaryQueue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: MemoryServiceOptions = {}) {
    this.store = options.store
    this.extractor = options.extractor ?? new RuleBasedMemoryExtractor()
    this.enabled = options.enabled ?? Boolean(options.store)
    this.recentMessageLimit = options.recentMessageLimit ?? DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT
    this.automaticRecallTokenBudget = positiveInteger(
      options.automaticRecallTokenBudget,
      DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    )
    this.searchResultLimit = memorySearchLimit(
      options.searchResultLimit ?? options.nodeLimit,
      DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
    )
    this.reviewEveryUserMessages = Math.max(
      1,
      Math.floor(
        options.reviewEveryUserMessages
        ?? options.summaryEveryMessages
        ?? DEFAULT_MEMORY_REVIEW_EVERY_USER_MESSAGES,
      ),
    )
    this.reviewAttemptTimeoutMs = Math.max(10, Math.floor(
      options.reviewAttemptTimeoutMs ?? MEMORY_REVIEW_ATTEMPT_TIMEOUT_MS,
    ))
    this.reviewExtractorResolvers = options.reviewExtractorResolver ? [options.reviewExtractorResolver] : []
    if (options.warning) this.warnings.add(options.warning)
  }

  configure(options: Pick<
    MemoryServiceOptions,
    | 'enabled'
    | 'recentMessageLimit'
    | 'automaticRecallTokenBudget'
    | 'searchResultLimit'
    | 'reviewEveryUserMessages'
  >): void {
    this.enabled = options.enabled ?? Boolean(this.store)
    this.recentMessageLimit = options.recentMessageLimit ?? DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT
    this.automaticRecallTokenBudget = positiveInteger(
      options.automaticRecallTokenBudget,
      DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    )
    this.searchResultLimit = memorySearchLimit(
      options.searchResultLimit,
      DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
    )
    this.reviewEveryUserMessages = Math.max(
      1,
      Math.floor(options.reviewEveryUserMessages ?? DEFAULT_MEMORY_REVIEW_EVERY_USER_MESSAGES),
    )
  }

  get isEnabled(): boolean {
    return this.enabled && Boolean(this.store)
  }

  async captureMessages(identity: MemoryRuntimeIdentity, messages: MemoryCaptureMessage[]): Promise<string[]> {
    if (!this.isEnabled || !this.store) return []
    const ids: string[] = []
    try {
      let parentId: string | undefined
      const occurrences = new Map<string, number>()
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        const signature = messageSignature(message)
        const occurrence = occurrences.get(signature) || 0
        occurrences.set(signature, occurrence + 1)
        const id = message.id || deterministicMessageId(identity.sessionId, occurrence, message)
        await this.store.appendMessage({
          id,
          sessionId: identity.sessionId,
          parentId,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
          createdAt: message.createdAt || new Date().toISOString(),
        })
        ids.push(id)
        parentId = id
      }
    } catch (error) {
      this.recordWarning(error)
    }
    return ids
  }

  async retrieve(
    identity: MemoryRuntimeIdentity,
    queryText?: string,
    overrides: Partial<MemoryQuery> = {},
  ): Promise<MemoryContext> {
    if (!this.isEnabled || !this.store) return this.disabledContext()
    try {
      const baseQuery = memoryQuery(identity, overrides)
      const recallQueryText = queryText || overrides.queryText
      const hasExactQuery = Boolean(overrides.key || overrides.kinds?.length || overrides.valueJson !== undefined)
      const contextualKinds = automaticRecallKinds(recallQueryText)
      const exactCandidatesPromise = hasExactQuery
        ? this.store.queryNodes({ ...baseQuery, queryText: undefined, limit: MEMORY_CANDIDATE_LIMIT })
        : Promise.all([
            this.store.queryNodes({
              ...baseQuery,
              queryText: undefined,
              kinds: ALWAYS_RECALLED_MEMORY_KINDS,
              limit: MEMORY_CANDIDATE_LIMIT,
            }),
            this.store.queryNodes({
              ...baseQuery,
              queryText: undefined,
              types: ['correction'],
              limit: MEMORY_CANDIDATE_LIMIT,
            }),
            contextualKinds.length
              ? this.store.queryNodes({
                  ...baseQuery,
                  queryText: undefined,
                  kinds: contextualKinds,
                  limit: MEMORY_CANDIDATE_LIMIT,
                })
              : Promise.resolve([]),
          ]).then(groups => uniqueMemoryNodes(groups.flat()))
      const [latestSummary, recentMessages, relevantCandidates, exactCandidates] = await Promise.all([
        this.store.getLatestSummary({ sessionId: identity.sessionId }),
        this.store.listRecentMessages({ sessionId: identity.sessionId, limit: this.recentMessageLimit }),
        this.store.queryNodes({
          ...baseQuery,
          queryText: recallQueryText,
          limit: MEMORY_CANDIDATE_LIMIT,
        }),
        exactCandidatesPromise,
      ])
      const pendingForgetIds = await this.pendingForgetNodeIds(identity.profileId || 'default')
      const result = resolveMemoryQuery(
        exactCandidates,
        relevantCandidates,
        recallQueryText,
        overrides.limit === undefined ? Number.MAX_SAFE_INTEGER : positiveInteger(overrides.limit, 1),
        new Date(),
      )
      const selection = selectMemoryNodesByTokenBudget(
        [...result.exact, ...result.relevant].filter(node => !pendingForgetIds.has(node.id)),
        this.automaticRecallTokenBudget,
      )
      const nodes = selection.nodes
      return {
        latestSummary,
        recentMessages,
        activeTasks: nodes.filter(node => node.type === 'task'),
        relevantNodes: nodes,
        constraints: nodes.filter(node => node.type === 'constraint' || node.type === 'correction'),
        preferences: nodes.filter(node => node.type === 'preference'),
        usedMemoryIds: nodes.map(node => node.id),
        diagnostics: {
          enabled: true,
          storeStatus: this.warnings.size ? 'degraded' : 'ok',
          warnings: [...this.warnings],
          retrievedNodeCount: nodes.length,
          omittedNodeCount: result.omitted.length + selection.omittedNodeIds.length,
          tokenBudget: this.automaticRecallTokenBudget,
          usedTokens: selection.usedTokens,
        },
      }
    } catch (error) {
      this.recordWarning(error)
      return this.degradedContext()
    }
  }

  async search(identity: MemoryRuntimeIdentity, query: MemoryQuery): Promise<MemoryQueryResult> {
    if (!this.isEnabled || !this.store) return { exact: [], relevant: [], omitted: [] }
    const scoped = memoryQuery(identity, query)
    const limit = memorySearchLimit(query.limit, this.searchResultLimit)
    const [relevantCandidates, exactCandidates] = await Promise.all([
      this.store.queryNodes({ ...scoped, limit: MEMORY_CANDIDATE_LIMIT }),
      query.key || query.kinds?.length || query.valueJson !== undefined
        ? this.store.queryNodes({ ...scoped, queryText: undefined, limit: MEMORY_CANDIDATE_LIMIT })
        : Promise.resolve([]),
    ])
    const pendingForgetIds = await this.pendingForgetNodeIds(identity.profileId || 'default')
    return resolveMemoryQuery(
      exactCandidates.filter(node => !pendingForgetIds.has(node.id)),
      relevantCandidates.filter(node => !pendingForgetIds.has(node.id)),
      query.queryText,
      limit,
    )
  }

  async get(id: string, identity?: Partial<MemoryRuntimeIdentity>): Promise<MemoryNode | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    const node = await this.store.getNode(id)
    return node && isNodeAccessible(node, identity) ? node : undefined
  }

  async list(query: MemoryQuery = {}): Promise<MemoryNode[]> {
    if (!this.isEnabled || !this.store) return []
    return this.store.queryNodes({
      ...query,
      profileId: query.profileId || 'default',
    })
  }

  async create(input: MemoryCreateInput): Promise<MemoryProposeUpdateResult> {
    return this.proposeUpdate({
      ...input,
      operation: 'create',
    })
  }

  async update(id: string, input: MemoryUpdateInput): Promise<MemoryProposeUpdateResult> {
    return this.proposeUpdate({
      ...input,
      operation: 'update',
      targetId: id,
      node: input.node ?? {},
    })
  }

  async expire(id: string, input: MemoryExpireInput): Promise<MemoryProposeUpdateResult> {
    return this.proposeUpdate({
      ...input,
      operation: 'expire',
      targetId: id,
      node: {},
    })
  }

  async delete(id: string, input: MemoryDeleteInput): Promise<MemoryForgetResult> {
    return this.forget({
      ...input,
      id,
    })
  }

  async listMessages(input: MemoryMessageListInput): Promise<MemoryMessage[]> {
    if (!this.isEnabled || !this.store) return []
    if (input.afterMessageId) {
      return this.store.listMessagesAfter({
        sessionId: input.sessionId,
        messageId: input.afterMessageId,
        limit: input.limit,
      })
    }
    return this.store.listRecentMessages({
      sessionId: input.sessionId,
      limit: input.limit ?? this.recentMessageLimit,
    })
  }

  async getLatestSummary(sessionId: string): Promise<MemorySummary | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    return this.store.getLatestSummary({ sessionId })
  }

  async getSessionState(sessionId: string): Promise<MemorySessionState | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    return this.store.getSessionState(sessionId)
  }

  async listAuditEvents(query: MemoryAuditQuery = {}): Promise<MemoryAuditEvent[]> {
    if (!this.isEnabled || !this.store) return []
    return this.store.listAuditEvents({
      ...query,
      profileId: query.profileId || 'default',
    })
  }

  async getReviewStatus(profileId = 'default'): Promise<MemoryReviewQueueStatus> {
    if (!this.isEnabled || !this.store) {
      return {
        reviewing: false,
        activeJobs: 0,
        pending: 0,
        running: 0,
        retry: 0,
        waitingForModel: 0,
        needsConfirmation: 0,
      }
    }
    const normalizedProfile = profileId || 'default'
    await this.recoverStaleReviewJobsForProfile(normalizedProfile)
    return this.store.getReviewQueueStatus(normalizedProfile)
  }

  async listReviewJobs(profileId = 'default'): Promise<MemoryReviewJob[]> {
    if (!this.isEnabled || !this.store) return []
    await this.recoverStaleReviewJobsForProfile(profileId || 'default')
    return this.store.listReviewJobs({
      profileId: profileId || 'default',
      statuses: ACTIVE_MEMORY_REVIEW_JOB_STATUSES,
      limit: 100,
    })
  }

  async reviewJobNow(id: string, profileId = 'default'): Promise<MemoryReviewJob | undefined> {
    if (!this.isEnabled || !this.store || this.closed) return undefined
    const normalizedProfile = profileId || 'default'
    await this.recoverStaleReviewJobsForProfile(normalizedProfile)
    const current = await this.store.getReviewJob(id)
    if (!current || current.profileId !== normalizedProfile) return undefined
    if (current.status === 'completed' || current.status === 'running') return current
    const activated = await this.store.activateReviewJob({
      id,
      profileId: normalizedProfile,
      now: new Date().toISOString(),
      confirmedByUser: true,
    })
    if (activated) this.startReviewWorker(normalizedProfile)
    return activated
  }

  async proposeUpdate(input: MemoryProposeUpdateInput): Promise<MemoryProposeUpdateResult> {
    if (!this.isEnabled || !this.store) return { accepted: false, reason: 'Memory store is disabled.' }
    const actor = input.actor || 'ekko-agent'
    if (input.operation === 'expire') {
      if (!input.targetId) return { accepted: false, reason: 'expire requires targetId.' }
      const target = await this.get(input.targetId, input.identity)
      if (!target) return { accepted: false, reason: 'Memory node not found.' }
      const revisionError = validateExpectedRevision(target, input.expectedRevision)
      if (revisionError) return { accepted: false, reason: revisionError }
      const changed = await this.store.updateNodeStatus({
        nodeId: input.targetId,
        status: 'expired',
        reason: input.reason,
        actor,
        expectedRevision: input.expectedRevision,
        sessionId: input.identity?.sessionId,
      })
      const node = changed ? await this.get(input.targetId, input.identity) : undefined
      return changed
        ? { accepted: true, nodeId: input.targetId, action: 'expired', node }
        : { accepted: false, reason: 'Memory revision changed before expiration.' }
    }
    if (input.operation === 'delete') {
      if (!input.targetId) return { accepted: false, reason: 'delete requires targetId.' }
      const target = await this.get(input.targetId, input.identity)
      if (!target) return { accepted: false, reason: 'Memory node not found.' }
      const revisionError = validateExpectedRevision(target, input.expectedRevision)
      if (revisionError) return { accepted: false, reason: revisionError }
      const changed = await this.store.deleteNode({
        nodeId: input.targetId,
        mode: 'soft',
        reason: input.reason,
        actor,
        expectedRevision: input.expectedRevision,
        sessionId: input.identity?.sessionId,
      })
      const node = changed ? await this.get(input.targetId, input.identity) : undefined
      return changed
        ? { accepted: true, nodeId: input.targetId, action: 'deleted', node }
        : { accepted: false, reason: 'Memory revision changed before deletion.' }
    }

    if (input.operation === 'update' || input.operation === 'supersede') {
      if (!input.targetId) return { accepted: false, reason: `${input.operation} requires targetId.` }
      const target = await this.get(input.targetId, input.identity)
      if (!target || target.status !== 'active') return { accepted: false, reason: 'Active memory node not found.' }
      const revisionError = validateExpectedRevision(target, input.expectedRevision)
      if (revisionError) return { accepted: false, reason: revisionError }
      const slot = memoryKindForCanonicalKey(target.key)
      if (!slot) return { accepted: false, reason: 'Memory has no server-controlled canonical key.' }
      const changesValue = input.node.valueJson !== undefined || input.valuePatch !== undefined || Boolean(input.unsetValueFields?.length)
      if (changesValue && (!input.node.title?.trim() || !input.node.content?.trim())) {
        return { accepted: false, reason: 'A value-changing memory update requires title and content derived from its supporting user evidence.' }
      }
      const valueJson = applyValuePatch(
        input.node.valueJson === undefined ? target.valueJson : input.node.valueJson,
        input.valuePatch,
        input.unsetValueFields,
      )
      const canonical = canonicalizeMemoryDraft(slot.kind, slot.itemKey, {
        ...target,
        ...input.node,
        id: undefined,
        parentId: target.id,
        supersedesId: target.id,
        profileId: target.profileId,
        scope: target.scope,
        origin: input.identity?.origin || target.origin,
        key: target.key,
        domain: target.domain,
        categoryPath: target.categoryPath,
        type: target.type,
        valueJson,
        revision: target.revision + 1,
        status: 'active',
        sourceMessageIds: uniqueValues([...target.sourceMessageIds, ...(input.node.sourceMessageIds || [])]),
        createdAt: undefined,
      })
      if (!canonical.accepted) return canonical
      const normalized = normalizeMemoryNode({
        draft: canonical.draft,
        identity: writableIdentityForNode(input.identity, target),
        explicitUserIntent: input.explicitUserIntent,
      })
      if (!normalized.accepted) return normalized
      const now = new Date().toISOString()
      const node: MemoryNode = { id: randomUUID(), ...normalized.node, updatedAt: now }
      await this.store.supersedeNode({
        oldNodeId: target.id,
        newNode: node,
        reason: input.reason,
        actor,
        sessionId: input.identity?.sessionId,
      })
      return { accepted: true, nodeId: node.id, action: 'updated', node }
    }

    const canonical = canonicalizeMemoryDraft(input.kind, input.itemKey, {
      ...input.node,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.identity?.origin ? { origin: input.identity.origin } : {}),
    })
    if (!canonical.accepted) return canonical
    const normalized = normalizeMemoryNode({
      draft: canonical.draft,
      identity: input.identity,
      explicitUserIntent: input.explicitUserIntent,
    })
    if (!normalized.accepted) return normalized
    const now = new Date().toISOString()
    let node: MemoryNode = { id: randomUUID(), ...normalized.node, revision: 1, updatedAt: now }
    const existing = (await this.store.queryNodes({
      ...memoryQuery(input.identity as MemoryRuntimeIdentity, {
        key: node.key,
        scopes: [node.scope || PROFILE_MEMORY_SCOPE],
        includeExpired: false,
      }),
      limit: 2,
    }))[0]
    if (existing && stableJson(existing.valueJson) === stableJson(node.valueJson) && existing.content === node.content) {
      return { accepted: true, nodeId: existing.id, action: 'noop', node: existing }
    }
    if (existing) {
      node = {
        ...node,
        revision: existing.revision + 1,
        parentId: existing.id,
        supersedesId: existing.id,
        sourceMessageIds: uniqueValues([...existing.sourceMessageIds, ...node.sourceMessageIds]),
      }
      await this.store.supersedeNode({
        oldNodeId: existing.id,
        newNode: node,
        reason: input.reason,
        actor,
        sessionId: input.identity?.sessionId,
      })
      return { accepted: true, nodeId: node.id, action: 'updated', node }
    }

    await this.store.upsertNode(node, {
      eventType: 'create',
      sessionId: input.identity?.sessionId,
      profileId: node.profileId,
      actor,
      reason: input.reason,
      payload: { type: node.type, key: node.key },
    })
    return { accepted: true, nodeId: node.id, action: 'created', node }
  }

  async forget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
    const mode = input.mode || 'soft'
    if (!this.isEnabled || !this.store) {
      return { deletedIds: [], mode, reason: 'Memory store is disabled.' }
    }
    const hasBroadSelector = Boolean(
      input.domain ||
      input.categoryPathPrefix?.length ||
      input.type ||
      input.key ||
      input.valueJson !== undefined,
    )
    if (
      !input.all &&
      !input.targets?.length &&
      !input.id &&
      !hasBroadSelector
    ) {
      return { deletedIds: [], mode, reason: 'A memory selector is required.' }
    }
    const selectorCount = Number(input.all === true) +
      Number(Boolean(input.targets?.length)) +
      Number(Boolean(input.id)) +
      Number(hasBroadSelector)
    if (selectorCount > 1) {
      return { deletedIds: [], mode, reason: 'Use exactly one memory selector: all, targets, id, or a broad query.' }
    }
    const exactTargets = input.targets?.length
      ? [...new Map(input.targets.map(target => [target.id, target])).values()]
      : undefined
    const expectedRevisions = new Map<string, number>()
    let candidates: MemoryNode[] = []
    if (exactTargets) {
      const resolved = await Promise.all(exactTargets.map(async target => ({
        target,
        node: await this.get(target.id, input.identity),
      })))
      const missing = resolved.find(item => !item.node)
      if (missing) return { deletedIds: [], mode, reason: `Memory node not found: ${missing.target.id}` }
      candidates = resolved.map(item => item.node!)
      for (const { target, node } of resolved) {
        const revisionError = validateExpectedRevision(node!, target.expectedRevision)
        if (revisionError) return { deletedIds: [], mode, reason: revisionError }
        expectedRevisions.set(target.id, target.expectedRevision)
      }
    } else if (input.id) {
      candidates = [await this.get(input.id, input.identity)].filter((node): node is MemoryNode => Boolean(node))
    } else {
      const baseQuery = memoryQuery(input.identity as MemoryRuntimeIdentity, {
        domain: input.all ? undefined : input.domain,
        categoryPathPrefix: input.all ? undefined : input.categoryPathPrefix,
        types: input.all || !input.type ? undefined : [input.type],
        key: input.all ? undefined : input.key,
        valueJson: input.all ? undefined : input.valueJson,
        includeExpired: true,
      })
      for (let offset = 0; ; offset += 500) {
        const page = await this.store.queryNodes({ ...baseQuery, limit: 500, offset })
        candidates.push(...page)
        if (page.length < 500) break
      }
    }
    if (!candidates.length) return { deletedIds: [], mode, reason: 'No matching memory was found.' }
    if (input.id) {
      const revisionError = validateExpectedRevision(candidates[0], input.expectedRevision)
      if (revisionError) return { deletedIds: [], mode, reason: revisionError }
    }
    if ((!input.confirmed && candidates.length > 1) || (mode === 'hard' && !input.confirmed)) {
      return {
        deletedIds: [],
        mode,
        requiresConfirmation: true,
        reason: mode === 'hard' ? 'Hard delete requires confirmation.' : 'Multiple memories matched; confirmation is required.',
      }
    }
    const deletedIds: string[] = []
    for (const node of candidates) {
      const deleted = await this.store.deleteNode({
        nodeId: node.id,
        mode,
        reason: input.reason,
        actor: input.actor || 'ekko-agent',
        expectedRevision: expectedRevisions.get(node.id) ?? (input.id ? input.expectedRevision : undefined),
        sessionId: input.identity?.sessionId,
      })
      if (deleted) deletedIds.push(node.id)
    }
    return {
      deletedIds,
      deletedMemories: candidates.filter(node => deletedIds.includes(node.id)).map(node => ({
        ...node,
        status: mode === 'soft' ? 'deleted' : node.status,
        revision: mode === 'soft' ? node.revision + 1 : node.revision,
      })),
      mode,
    }
  }

  async scheduleReview(input: MemoryReviewScheduleInput): Promise<MemoryReviewJob | undefined> {
    if (!this.isEnabled || !this.store || this.closed) return undefined
    const profileId = input.identity.profileId || 'default'
    const createdAt = new Date().toISOString()
    const id = reviewJobId({
      profileId,
      sessionId: input.identity.sessionId,
      throughMessageId: input.throughMessageId,
      request: input.request,
    })
    const job = await this.store.enqueueReviewJob({
      id,
      profileId,
      sessionId: input.identity.sessionId,
      throughMessageId: input.throughMessageId,
      identity: { ...input.identity, profileId },
      request: input.request,
      preferredProvider: input.preferredProvider,
      preferredModel: input.preferredModel,
      createdAt,
    })
    if (input.extractor) this.reviewExtractors.set(job.id, input.extractor)
    this.wakeReviewJobs(profileId)
    return job
  }

  wakeReviewJobs(profileId?: string): void {
    if (!this.isEnabled || !this.store || this.closed) return
    if (profileId) {
      this.startReviewWorker(profileId)
      return
    }
    const now = new Date()
    void this.store.listPendingReviewProfiles({
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - MEMORY_REVIEW_LEASE_MS).toISOString(),
    }).then(profiles => {
      for (const profile of profiles) this.startReviewWorker(profile)
    }).catch(error => this.recordWarning(error))
  }

  async recoverReviewJobs(): Promise<void> {
    if (!this.isEnabled || !this.store || this.closed) return
    const now = new Date()
    await this.store.requeueStaleReviewJobs({
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - MEMORY_REVIEW_LEASE_MS).toISOString(),
    })
    if (typeof this.store.activateReviewJobs === 'function') {
      await this.store.activateReviewJobs({ now: now.toISOString() })
    }
    this.wakeReviewJobs()
  }

  registerReviewExtractor(profileId: string, resolution: MemoryReviewExtractorResolution): void {
    const normalizedProfile = profileId || 'default'
    this.profileReviewExtractors.set(normalizedProfile, resolution)
    if (!this.store || !this.isEnabled || this.closed) return
    if (typeof this.store.activateReviewJobs !== 'function') {
      this.startReviewWorker(normalizedProfile)
      return
    }
    void this.store.activateReviewJobs({
      profileId: normalizedProfile,
      now: new Date().toISOString(),
    }).then(() => this.startReviewWorker(normalizedProfile)).catch(error => this.recordWarning(error))
  }

  registerReviewExtractorResolver(resolver: MemoryReviewExtractorResolver): void {
    this.reviewExtractorResolvers.unshift(resolver)
    void this.recoverReviewJobs().catch(error => this.recordWarning(error))
  }

  clearRegisteredReviewExtractors(): void {
    this.profileReviewExtractors.clear()
  }

  scheduleExtraction(identity: MemoryRuntimeIdentity): void {
    if (!this.isEnabled || !this.store) return
    this.summaryQueue = this.summaryQueue
      .then(() => this.enqueuePeriodicReview(identity, this.extractor, true))
      .catch(error => this.recordWarning(error))
  }

  scheduleRunCompletion(
    identity: MemoryRuntimeIdentity,
    messages: MemoryCaptureMessage[],
    extractor: MemoryExtractor = this.extractor,
    options: MemoryRunCompletionOptions = {},
  ): void {
    if (!this.isEnabled || !this.store) return
    const explicitIntent = hasExplicitMemoryIntent(messages)
    if (options.reviewPolicy === 'explicit-only' && !explicitIntent) return
    const forceReview = !options.reviewAlreadyScheduled && (
      options.forceReview === true || explicitIntent || hasHighSignalMemoryCandidate(messages)
    )
    this.summaryQueue = this.summaryQueue
      .then(async () => {
        const ids = await this.captureMessages(identity, messages)
        const throughMessageId = ids.at(-1)
        if (!throughMessageId) return
        if (!options.reviewAlreadyScheduled) {
          await this.enqueuePeriodicReview(
            identity,
            extractor,
            forceReview,
            throughMessageId,
            options.preferredProvider,
            options.preferredModel,
          )
        }
        await this.summarizeIfDue(identity, options.summaryExtractor ?? extractor)
      })
      .catch(error => this.recordWarning(error))
  }

  async drain(): Promise<void> {
    await this.summaryQueue
    await Promise.allSettled([...this.reviewWorkers.values()])
  }

  close(): void {
    this.closed = true
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryTimerDueAt.clear()
    this.reviewWorkerWakeups.clear()
    this.reviewExtractors.clear()
    this.profileReviewExtractors.clear()
    this.store?.close()
  }

  contextPrompt(context: MemoryContext): string {
    return buildMemoryContextPrompt(context)
  }

  private async reviewAndPersist(
    identity: MemoryRuntimeIdentity,
    extractor: MemoryExtractor = this.extractor,
    throughMessageId?: string,
    request?: MemoryReviewJobRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.store) return
    while (!this.closed) {
      const state = await this.store.getSessionState(identity.sessionId)
      const messages = await this.store.listMessagesAfter({
        sessionId: identity.sessionId,
        messageId: state?.lastReviewedMessageId ?? state?.lastExtractedMessageId,
        throughMessageId,
        limit: MEMORY_REVIEW_MESSAGE_BATCH_LIMIT,
      })
      if (!messages.length) return
      const reachedTarget = !throughMessageId || messages.at(-1)?.id === throughMessageId
      const previousSummary = await this.store.getLatestSummary({ sessionId: identity.sessionId })
      const extraction = await extractor.extract({
        ...identity,
        previousSummary,
        messages,
        reviewRequest: reachedTarget ? request : { trigger: 'periodic' },
        signal,
      })
      if (extraction.fallbackReason) {
        throw new Error(`Memory review did not complete: ${extraction.fallbackReason}`)
      }
      for (const operation of extraction.nodes) {
        if (operation.operation === 'ignore') continue
        const result = await this.proposeUpdate({
          operation: operation.operation,
          kind: operation.kind,
          itemKey: operation.itemKey,
          scope: operation.scope,
          targetId: operation.targetId,
          expectedRevision: operation.expectedRevision,
          node: {
            ...operation.node,
            sourceMessageIds: operation.node.sourceMessageIds?.length
              ? operation.node.sourceMessageIds
              : messages.map(message => message.id),
          },
          reason: operation.reason,
          actor: 'memory-reviewer',
          explicitUserIntent: operation.explicitUserIntent,
          identity,
        })
        if (!result.accepted) throw new Error(result.reason || 'Memory review mutation was rejected.')
      }
      const lastReviewedMessageId = messages.at(-1)?.id
      const reviewedAt = new Date().toISOString()
      await this.store.setSessionState({
        sessionId: identity.sessionId,
        lastExtractedMessageId: lastReviewedMessageId,
        lastReviewedMessageId,
        updatedAt: reviewedAt,
      })
      await this.store.appendAuditEvent({
        id: randomUUID(),
        eventType: 'extract',
        sessionId: identity.sessionId,
        profileId: identity.profileId || 'default',
        actor: 'memory-reviewer',
        reason: 'Reviewed new conversation messages',
        payload: {
          fromMessageId: messages[0].id,
          toMessageId: lastReviewedMessageId,
          operations: extraction.nodes.length,
        },
        createdAt: reviewedAt,
      })
      if (reachedTarget) return
    }
  }

  private async enqueuePeriodicReview(
    identity: MemoryRuntimeIdentity,
    extractor: MemoryExtractor,
    forceReview: boolean,
    capturedThroughMessageId?: string,
    preferredProvider?: string,
    preferredModel?: string,
  ): Promise<void> {
    if (!this.store) return
    const state = await this.store.getSessionState(identity.sessionId)
    const messages = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastReviewedMessageId ?? state?.lastExtractedMessageId,
      limit: 100,
    })
    if (!messages.length) return
    if (!forceReview && messages.filter(message => message.role === 'user').length < this.reviewEveryUserMessages) {
      return
    }
    const throughMessageId = capturedThroughMessageId || messages.at(-1)?.id
    if (!throughMessageId) return
    await this.scheduleReview({
      identity,
      throughMessageId,
      request: { trigger: forceReview ? 'review' : 'periodic' },
      extractor,
      preferredProvider,
      preferredModel,
    })
  }

  private startReviewWorker(profileId: string): void {
    if (this.closed) return
    if (this.reviewWorkers.has(profileId)) {
      this.reviewWorkerWakeups.add(profileId)
      return
    }
    const worker = this.runReviewWorker(profileId)
      .catch(error => this.recordWarning(error))
      .finally(() => {
        if (this.reviewWorkers.get(profileId) !== worker) return
        this.reviewWorkers.delete(profileId)
        if (this.reviewWorkerWakeups.delete(profileId)) this.startReviewWorker(profileId)
      })
    this.reviewWorkers.set(profileId, worker)
  }

  private async runReviewWorker(profileId: string): Promise<void> {
    if (!this.store) return
    while (!this.closed) {
      const now = new Date()
      const job = await this.store.claimNextReviewJob({
        profileId,
        now: now.toISOString(),
        staleBefore: new Date(now.getTime() - MEMORY_REVIEW_LEASE_MS).toISOString(),
      })
      if (!job) return
      try {
        const deterministic = await this.tryDeterministicReview(job)
        if (deterministic === 'completed') {
          await this.completeReviewJob(job)
          continue
        }
        if (deterministic === 'needs_confirmation') {
          await this.store.updateReviewJob(job.id, {
            status: 'needs_confirmation',
            lastError: 'Memory deletion requires confirmation.',
          })
          continue
        }
        const jobExtractor = this.reviewExtractors.get(job.id)
        const resolvedExtractor = jobExtractor
          ? undefined
          : await this.resolveReviewExtractor(job)
        const extractor = jobExtractor
          ? { extractor: jobExtractor }
          : resolvedExtractor ?? (
              this.reviewExtractorResolvers.length
                ? undefined
                : this.profileReviewExtractors.get(profileId)
            )
        if (!extractor) {
          const delay = reviewRetryDelay(job.attempt)
          await this.store.updateReviewJob(job.id, {
            status: 'waiting_for_model',
            nextAttemptAt: new Date(Date.now() + delay).toISOString(),
            lastError: 'No usable model is currently available for memory review.',
          })
          this.scheduleReviewRetry(profileId, delay)
          continue
        }
        await this.runReviewAttempt(job, extractor.extractor)
        await this.completeReviewJob(job)
      } catch (error) {
        if (error instanceof MemoryReviewNeedsConfirmationError) {
          await this.store.updateReviewJob(job.id, {
            status: 'needs_confirmation',
            lastError: error.message,
          })
          continue
        }
        const deterministic = await this.tryDeterministicReview(job)
        if (deterministic === 'completed') {
          await this.completeReviewJob(job)
          continue
        }
        if (deterministic === 'needs_confirmation') {
          await this.store.updateReviewJob(job.id, {
            status: 'needs_confirmation',
            lastError: 'Memory deletion requires confirmation.',
          })
          continue
        }
        const delay = reviewRetryDelay(job.attempt)
        const message = error instanceof Error ? error.message : String(error)
        await this.store.updateReviewJob(job.id, {
          status: 'retry',
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          lastError: message,
        })
        this.recordWarning(error)
        this.scheduleReviewRetry(profileId, delay)
      } finally {
        this.reviewExtractors.delete(job.id)
      }
    }
  }

  private async completeReviewJob(job: MemoryReviewJob): Promise<void> {
    if (!this.store) return
    await this.store.updateReviewJob(job.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    })
  }

  private async runReviewAttempt(job: MemoryReviewJob, extractor: MemoryExtractor): Promise<void> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Memory review attempt timed out after ${this.reviewAttemptTimeoutMs}ms.`,
        )
        controller.abort(error)
        reject(error)
      }, this.reviewAttemptTimeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([
        this.reviewAndPersist(
          job.identity,
          extractor,
          job.throughMessageId,
          job.request,
          controller.signal,
        ),
        timeout,
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (!controller.signal.aborted) controller.abort()
    }
  }

  private async resolveReviewExtractor(
    job: MemoryReviewJob,
  ): Promise<MemoryReviewExtractorResolution | undefined> {
    for (const resolver of this.reviewExtractorResolvers) {
      try {
        const resolution = await resolver(job)
        if (resolution) return resolution
      } catch (error) {
        this.recordWarning(error)
      }
    }
    return undefined
  }

  private async tryDeterministicReview(
    job: MemoryReviewJob,
  ): Promise<'completed' | 'needs_confirmation' | 'unavailable'> {
    const forget = job.request.forget
    if (job.request.trigger !== 'forget' || !forget) return 'unavailable'
    const hasSelector = Boolean(
      forget.all ||
      forget.targets?.length ||
      forget.id ||
      forget.domain ||
      forget.categoryPathPrefix?.length ||
      forget.type ||
      forget.key ||
      forget.valueJson !== undefined,
    )
    if (!hasSelector) return 'unavailable'

    let request = forget
    if (forget.id) {
      const current = await this.get(forget.id, job.identity)
      if (!current || current.status === 'deleted') return 'completed'
    } else if (forget.targets?.length) {
      const remainingTargets: Array<{ id: string; expectedRevision: number }> = []
      for (const target of forget.targets) {
        const current = await this.get(target.id, job.identity)
        if (current && current.status !== 'deleted') remainingTargets.push(target)
      }
      if (!remainingTargets.length) return 'completed'
      request = { ...forget, targets: remainingTargets }
    }
    const result = await this.forget({
      ...request,
      identity: job.identity,
      actor: 'memory-reviewer-deterministic',
    })
    if (result.requiresConfirmation) return 'needs_confirmation'
    if (result.deletedIds.length || result.reason === 'No matching memory was found.') return 'completed'
    throw new Error(result.reason || 'Deterministic memory deletion was rejected.')
  }

  private scheduleReviewRetry(profileId: string, delay: number): void {
    const existing = this.retryTimers.get(profileId)
    const dueAt = Date.now() + delay
    if (existing && (this.retryTimerDueAt.get(profileId) ?? Number.POSITIVE_INFINITY) <= dueAt) return
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(profileId)
      this.retryTimerDueAt.delete(profileId)
      this.startReviewWorker(profileId)
    }, delay)
    timer.unref?.()
    this.retryTimers.set(profileId, timer)
    this.retryTimerDueAt.set(profileId, dueAt)
  }

  private async summarizeIfDue(identity: MemoryRuntimeIdentity, extractor: MemoryExtractor): Promise<void> {
    if (!this.store) return
    const state = await this.store.getSessionState(identity.sessionId)
    const messages = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastSummaryMessageId,
      limit: 500,
    })
    if (messages.filter(message => message.role === 'user').length < this.reviewEveryUserMessages) return
    const previousSummary = await this.store.getLatestSummary({ sessionId: identity.sessionId })
    const extraction = await extractor.extract({ ...identity, previousSummary, messages })
    if (!extraction.summaryPatch) return
    const summary = buildSummary(identity.sessionId, previousSummary, messages, extraction)
    await this.store.appendSummary(summary)
    await this.store.setSessionState({
      sessionId: identity.sessionId,
      lastSummaryMessageId: messages.at(-1)?.id,
      updatedAt: summary.createdAt,
    })
    await this.store.appendAuditEvent({
      id: randomUUID(),
      eventType: 'summary',
      sessionId: identity.sessionId,
      profileId: identity.profileId || 'default',
      actor: 'memory-summarizer',
      reason: extraction.fallbackReason ? 'Periodic chained summary (safe fallback)' : 'Periodic chained summary',
      payload: {
        summaryId: summary.id,
        fromMessageId: summary.fromMessageId,
        toMessageId: summary.toMessageId,
        ...(extraction.fallbackReason ? { fallbackReason: extraction.fallbackReason } : {}),
      },
      createdAt: summary.createdAt,
    })
  }

  private async pendingForgetNodeIds(profileId: string): Promise<Set<string>> {
    if (!this.store) return new Set()
    const jobs = await this.store.listReviewJobs({
      profileId,
      statuses: ACTIVE_MEMORY_REVIEW_JOB_STATUSES,
      limit: 500,
    })
    const ids = new Set<string>()
    for (const job of jobs) {
      const forget = job.request.trigger === 'forget' ? job.request.forget : undefined
      if (!forget) continue
      if (forget.id) ids.add(forget.id)
      for (const target of forget.targets || []) ids.add(target.id)
      const hasBroadSelector = Boolean(
        forget.all || forget.domain || forget.categoryPathPrefix?.length ||
        forget.type || forget.key || forget.valueJson !== undefined,
      )
      if (!hasBroadSelector) continue
      const query = memoryQuery(job.identity, {
        domain: forget.all ? undefined : forget.domain,
        categoryPathPrefix: forget.all ? undefined : forget.categoryPathPrefix,
        types: forget.all || !forget.type ? undefined : [forget.type],
        key: forget.all ? undefined : forget.key,
        valueJson: forget.all ? undefined : forget.valueJson,
        includeExpired: true,
      })
      for (let offset = 0; ; offset += 500) {
        const page = await this.store.queryNodes({ ...query, limit: 500, offset })
        for (const node of page) ids.add(node.id)
        if (page.length < 500) break
      }
    }
    return ids
  }

  private async recoverStaleReviewJobsForProfile(profileId: string): Promise<void> {
    if (!this.store || this.closed) return
    const now = new Date()
    const recovered = await this.store.requeueStaleReviewJobs({
      profileId,
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - MEMORY_REVIEW_LEASE_MS).toISOString(),
    })
    if (recovered > 0) this.startReviewWorker(profileId)
  }

  private disabledContext(): MemoryContext {
    return emptyContext({
      enabled: false,
      storeStatus: 'disabled',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private degradedContext(): MemoryContext {
    return emptyContext({
      enabled: true,
      storeStatus: 'degraded',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private recordWarning(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.warnings.add(message)
  }
}

function memoryQuery(identity: Partial<MemoryRuntimeIdentity> | undefined, overrides: Partial<MemoryQuery>): MemoryQuery {
  return {
    ...overrides,
    profileId: identity?.profileId || 'default',
    scopes: overrides.scopes ?? normalizeMemoryScopes(identity?.recallScopes),
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(Number(value)))
}

function memorySearchLimit(value: number | undefined, fallback: number): number {
  return Math.min(positiveInteger(value, fallback), MAX_MEMORY_SEARCH_RESULTS)
}

function automaticRecallKinds(queryText: string | undefined): NonNullable<MemoryQuery['kinds']> {
  const text = String(queryText || '').normalize('NFKC').toLowerCase()
  if (!text) return []
  const kinds = new Set<NonNullable<MemoryQuery['kinds']>[number]>()
  for (const rule of AUTOMATIC_RECALL_KIND_RULES) {
    if (rule.pattern.test(text)) {
      for (const kind of rule.kinds) kinds.add(kind)
    }
  }
  return [...kinds]
}

function uniqueMemoryNodes(nodes: MemoryNode[]): MemoryNode[] {
  const seen = new Set<string>()
  return nodes.filter(node => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

const AUTOMATIC_RECALL_KIND_RULES: Array<{
  kinds: NonNullable<MemoryQuery['kinds']>
  pattern: RegExp
}> = [
  { kinds: ['profile_name'], pattern: /\bname\b|姓名|名字|叫什么|称呼/ },
  { kinds: ['home_location'], pattern: /\bhome\b|\blocation\b|\bcity\b|\bwhere (?:do|does) .{0,40}\blive\b|常住|住在|家住|城市|所在地/ },
  { kinds: ['occupation'], pattern: /\bjob\b|\boccupation\b|\bcareer\b|\bemployer\b|职业|上班|任职|工作单位|我的工作/ },
  { kinds: ['timezone_preference'], pattern: /\btimezone\b|\btime zone\b|时区|当地时间/ },
  { kinds: ['general_preference'], pattern: /\bprefer(?:ence|s|red)?\b|\bmy preferences?\b|偏好|喜欢|习惯用/ },
  { kinds: ['workflow_preference'], pattern: /\bworkflow\b|\bprocess\b|工作流|流程|协作方式/ },
  { kinds: ['tool_preference'], pattern: /\btool(?:ing|s)?\b|\beditor\b|\bide\b|工具|编辑器/ },
  { kinds: ['personal_relationship'], pattern: /\brelationship\b|\bfamily\b|\bfriend\b|家人|家庭|朋友|关系/ },
  { kinds: ['habit_routine'], pattern: /\bhabit\b|\broutine\b|\bdaily\b|\bweekly\b|习惯|日常|每天|每周/ },
  { kinds: ['environment_fact'], pattern: /\benvironment\b|\bdevice\b|\bmachine\b|\bos\b|环境|设备|电脑|系统/ },
  { kinds: ['project_context'], pattern: /\bproject\b|\brepository\b|\brepo\b|\bcodebase\b|项目|代码库|仓库/ },
  { kinds: ['long_term_goal'], pattern: /\bgoal\b|\blong[- ]term\b|长期目标|目标|规划/ },
  { kinds: ['durable_decision'], pattern: /\bdecision\b|\bdecide(?:d)?\b|决定|决策|选定/ },
  { kinds: ['food_avoidance'], pattern: /\bfood\b|\beat\b|\bdish\b|\bcook\b|\bmenu\b|\brestaurant\b|\ballerg(?:y|ic)\b|吃|菜|餐|食物|忌口|过敏|做饭|烹饪/ },
]

function deterministicMessageId(sessionId: string, occurrence: number, message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(occurrence))
    .update('\0')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

function messageSignature(message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

function reviewJobId(input: {
  profileId: string
  sessionId: string
  throughMessageId: string
  request: MemoryReviewJobRequest
}): string {
  return createHash('sha256')
    .update(input.profileId)
    .update('\0')
    .update(input.sessionId)
    .update('\0')
    .update(input.throughMessageId)
    .update('\0')
    .update(stableJson(reviewRequestDedupePayload(input.request)))
    .digest('hex')
}

function reviewRequestDedupePayload(request: MemoryReviewJobRequest): MemoryReviewJobRequest {
  if (request.trigger !== 'forget' || !request.forget) return request
  const { reason: _reason, targets, ...forget } = request.forget
  return {
    trigger: 'forget',
    forget: {
      ...forget,
      ...(targets?.length
        ? { targets: [...targets].sort((left, right) => left.id.localeCompare(right.id)) }
        : {}),
      reason: '',
    },
  }
}

function reviewRetryDelay(attempt: number): number {
  return Math.min(
    MEMORY_REVIEW_RETRY_MAX_MS,
    MEMORY_REVIEW_RETRY_BASE_MS * (2 ** Math.max(0, Math.min(attempt - 1, 6))),
  )
}

export function hasExplicitMemoryIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  return /(?:记住|记下来|保存(?:到|为)?记忆|以后(?:都|请)?|从现在起|忘掉|忘记|删除.{0,8}(?:记忆|偏好|记录)|更正.{0,8}(?:记忆|偏好|信息)|更新.{0,8}(?:记忆|偏好|信息)|remember|from now on|forget|delete (?:that|this|my) memory|update my memory)/i.test(latestUser)
}

export function hasExplicitMemoryForgetIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  return /(?:忘掉|忘记|别记|删除.{0,12}(?:记忆|偏好|记录|信息)|不再记|forget|delete (?:that|this|my|the).{0,20}(?:memory|preference|record))/i.test(latestUser)
}

export function hasExplicitMemoryForgetAllIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  return /(?:忘掉|忘记|删除|清空).{0,16}(?:所有|全部).{0,12}(?:记忆|偏好|记录|信息)|(?:forget|delete|clear).{0,16}(?:all|every).{0,16}(?:memories|memory|preferences|records)/i.test(latestUser)
}

function hasHighSignalMemoryCandidate(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  const highSignalPatterns = [
    /(?:记住|记下来|保存(?:这个|这条|我的)?|以后(?:都|请)?|长期|忘掉|忘记|别记|删除.{0,8}(?:记忆|偏好|记录)|更正|改成|更新.{0,8}(?:记忆|偏好|信息))/i,
    /(?:我(?:是|叫|来自|住在|常住|在.{0,12}工作|的名字是|的职业是|的身份是)|我的(?:名字|职业|身份|家乡|住址|系统|环境|工作流|习惯|偏好|项目)(?:是|为|用)|叫我|称呼我|你是我的|我是你的)/i,
    /(?:我(?:喜欢|偏好|习惯|通常|总是|从不|不喜欢|讨厌|不吃|不用|需要|希望|要求)|别再|不要再|以后别|对我(?:要|请)|我对.{0,12}(?:过敏|不耐受))/i,
    /(?:不是.{0,30}(?:而是|是)|其实我|我现在|我已经不|之前.{0,20}(?:错了|不对)|纠正一下)/i,
    /(?:remember|from now on|forget|delete (?:that|this|my) memory|update my memory|my name is|call me|i am|i'm|i live|i work|i use|i prefer|i like|i dislike|i hate|i always|i never|i need|i want you to|don't call me|do not call me|actually,? i|not .{0,30} but)/i,
  ]
  return highSignalPatterns.some(pattern => pattern.test(latestUser))
}

function validateExpectedRevision(node: MemoryNode, expectedRevision: number | undefined): string | undefined {
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
    return 'Mutation requires expectedRevision from memory_search, memory_get, or the injected memory card.'
  }
  if (node.revision !== expectedRevision) {
    return `Memory revision mismatch: expected ${expectedRevision}, current ${node.revision}. Search again before mutating.`
  }
  return undefined
}

function applyValuePatch(
  base: unknown,
  patch: Record<string, unknown> | undefined,
  unsetFields: string[] | undefined,
): unknown {
  if (!patch && !unsetFields?.length) return base
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return patch ? { ...patch } : base
  }
  const output = { ...(base as Record<string, unknown>), ...(patch || {}) }
  for (const field of unsetFields || []) delete output[field]
  return output
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function buildSummary(
  sessionId: string,
  previous: MemorySummary | undefined,
  messages: MemoryMessage[],
  extraction: MemoryExtraction,
): MemorySummary {
  const userText = messages.filter(message => message.role === 'user').map(message => message.content)
  const assistantText = messages.filter(message => message.role === 'assistant').map(message => message.content)
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    sessionId,
    parentSummaryId: previous?.id,
    fromMessageId: messages[0].id,
    toMessageId: messages.at(-1)!.id,
    summary: extraction.summaryPatch!,
    currentGoal: extraction.currentGoal,
    constraints: extraction.constraints ?? collectMatches(userText, /(?:必须|不要|不能|constraint)[:：]?\s*([^。\n]+)/gi),
    preferences: extraction.preferences ?? collectMatches(userText, /(?:喜欢|偏好|prefer)[:：]?\s*([^。\n]+)/gi),
    decisions: extraction.decisions ?? collectMatches(userText, /(?:决定|采用|decision)[:：]?\s*([^。\n]+)/gi),
    completedWork: extraction.completedWork ?? collectMatches(assistantText, /(?:已完成|完成了|completed)[:：]?\s*([^。\n]+)/gi),
    pendingWork: extraction.pendingWork ?? collectMatches([...userText, ...assistantText], /(?:待办|下一步|pending)[:：]?\s*([^。\n]+)/gi),
    knownIssues: extraction.knownIssues ?? collectMatches([...userText, ...assistantText], /(?:问题|错误|issue)[:：]?\s*([^。\n]+)/gi),
    createdAt: now,
  }
}

function collectMatches(values: string[], pattern: RegExp): string[] {
  const output = new Set<string>()
  for (const value of values) {
    pattern.lastIndex = 0
    for (const match of value.matchAll(pattern)) {
      if (match[1]?.trim()) output.add(match[1].trim())
    }
  }
  return [...output].slice(0, 10)
}

function emptyContext(diagnostics: MemoryContext['diagnostics']): MemoryContext {
  return {
    recentMessages: [],
    activeTasks: [],
    relevantNodes: [],
    constraints: [],
    preferences: [],
    usedMemoryIds: [],
    diagnostics,
  }
}

function isNodeAccessible(node: MemoryNode, identity: Partial<MemoryRuntimeIdentity> | undefined): boolean {
  if ((identity?.profileId || 'default') !== node.profileId) return false
  if (identity?.recallScopes?.length) return memoryScopeAllowed(node.scope, identity.recallScopes)
  // Session-bound callers are runtime actors and inherit the safe profile-only
  // default. Sessionless callers are administrative APIs that already own the
  // profile and need to inspect scoped cards for maintenance.
  return !identity?.sessionId || memoryScopeAllowed(node.scope, [PROFILE_MEMORY_SCOPE])
}

function writableIdentityForNode(
  identity: Partial<MemoryRuntimeIdentity> | undefined,
  node: MemoryNode,
): Partial<MemoryRuntimeIdentity> {
  if (identity?.writeScopes?.length) return identity
  return {
    ...identity,
    writeScopes: [node.scope || PROFILE_MEMORY_SCOPE],
    defaultWriteScope: node.scope || PROFILE_MEMORY_SCOPE,
  }
}
