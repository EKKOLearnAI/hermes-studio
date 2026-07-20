import { createHash, randomUUID } from 'node:crypto'
import { buildMemoryContextPrompt } from './context'
import { RuleBasedMemoryExtractor } from './extraction'
import { resolveMemoryQuery } from './retrieval'
import { canonicalizeMemoryDraft, memoryKindForCanonicalKey, normalizeMemoryNode } from './schema'
import { stableJson } from './store'
import type {
  MemoryAuditEvent,
  MemoryContext,
  MemoryExtraction,
  MemoryExtractor,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryMessage,
  MemoryMessageRole,
  MemoryNode,
  MemoryProposeUpdateInput,
  MemoryProposeUpdateResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRuntimeIdentity,
  MemoryStore,
  MemorySummary,
} from './types'

export interface MemoryServiceOptions {
  store?: MemoryStore
  extractor?: MemoryExtractor
  enabled?: boolean
  warning?: string
  recentMessageLimit?: number
  nodeLimit?: number
  reviewEveryUserMessages?: number
  /** @deprecated Use reviewEveryUserMessages. */
  summaryEveryMessages?: number
}

export interface MemoryCaptureMessage {
  id?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export class MemoryService {
  private readonly store?: MemoryStore
  private readonly extractor: MemoryExtractor
  private readonly enabled: boolean
  private readonly recentMessageLimit: number
  private readonly nodeLimit: number
  private readonly reviewEveryUserMessages: number
  private readonly warnings = new Set<string>()
  private extractionQueue: Promise<void> = Promise.resolve()

  constructor(options: MemoryServiceOptions = {}) {
    this.store = options.store
    this.extractor = options.extractor ?? new RuleBasedMemoryExtractor()
    this.enabled = options.enabled ?? Boolean(options.store)
    this.recentMessageLimit = options.recentMessageLimit ?? 6
    this.nodeLimit = options.nodeLimit ?? 12
    this.reviewEveryUserMessages = Math.max(
      1,
      Math.floor(options.reviewEveryUserMessages ?? options.summaryEveryMessages ?? 1),
    )
    if (options.warning) this.warnings.add(options.warning)
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
      const [latestSummary, recentMessages, relevantCandidates] = await Promise.all([
        this.store.getLatestSummary({ sessionId: identity.sessionId }),
        this.store.listRecentMessages({ sessionId: identity.sessionId, limit: this.recentMessageLimit }),
        this.store.queryNodes({ ...baseQuery, limit: 100 }),
      ])
      const exactCandidates = overrides.key || overrides.valueJson !== undefined
        ? await this.store.queryNodes({ ...baseQuery, queryText: undefined, limit: 100 })
        : []
      const result = resolveMemoryQuery(
        exactCandidates,
        relevantCandidates,
        queryText || overrides.queryText,
        overrides.limit ?? this.nodeLimit,
        new Date(),
        { includeAlwaysApplicable: true },
      )
      const nodes = [...result.exact, ...result.relevant]
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
          omittedNodeCount: result.omitted.length,
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
    const candidates = await this.store.queryNodes({ ...scoped, queryText: undefined, limit: 150 })
    const exactCandidates = query.key || query.valueJson !== undefined ? candidates : []
    return resolveMemoryQuery(exactCandidates, candidates, query.queryText, query.limit ?? this.nodeLimit)
  }

  async get(id: string, identity?: Partial<MemoryRuntimeIdentity>): Promise<MemoryNode | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    const node = await this.store.getNode(id)
    return node && isNodeAccessible(node, identity) ? node : undefined
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
        identity: input.identity,
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

    const canonical = canonicalizeMemoryDraft(input.kind, input.itemKey, input.node)
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
      ...memoryQuery(input.identity as MemoryRuntimeIdentity, { key: node.key, includeExpired: false }),
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
    if (!input.id && !input.domain && !input.type && !input.key && input.valueJson === undefined) {
      return { deletedIds: [], mode, reason: 'A memory selector is required.' }
    }
    const candidates = input.id
      ? [await this.get(input.id, input.identity)].filter((node): node is MemoryNode => Boolean(node))
      : await this.store.queryNodes(memoryQuery(input.identity as MemoryRuntimeIdentity, {
          domain: input.domain,
          categoryPathPrefix: input.categoryPathPrefix,
          types: input.type ? [input.type] : undefined,
          key: input.key,
          valueJson: input.valueJson,
          includeExpired: true,
          limit: 100,
        }))
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
        expectedRevision: input.id ? input.expectedRevision : undefined,
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

  scheduleExtraction(identity: MemoryRuntimeIdentity): void {
    if (!this.isEnabled || !this.store) return
    this.extractionQueue = this.extractionQueue
      .then(() => this.extractAndPersist(identity, this.extractor, true))
      .catch(error => this.recordWarning(error))
  }

  scheduleRunCompletion(
    identity: MemoryRuntimeIdentity,
    messages: MemoryCaptureMessage[],
    extractor: MemoryExtractor = this.extractor,
  ): void {
    if (!this.isEnabled || !this.store) return
    const forceReview = hasHighSignalMemoryCandidate(messages)
    this.extractionQueue = this.extractionQueue
      .then(async () => {
        await this.captureMessages(identity, messages)
        await this.extractAndPersist(identity, extractor, forceReview)
      })
      .catch(error => this.recordWarning(error))
  }

  async drain(): Promise<void> {
    await this.extractionQueue
  }

  close(): void {
    this.store?.close()
  }

  contextPrompt(context: MemoryContext): string {
    return buildMemoryContextPrompt(context)
  }

  private async extractAndPersist(
    identity: MemoryRuntimeIdentity,
    extractor: MemoryExtractor = this.extractor,
    forceReview = false,
  ): Promise<void> {
    if (!this.store) return
    const state = await this.store.getSessionState(identity.sessionId)
    const messages = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastExtractedMessageId,
      limit: 100,
    })
    if (!messages.length) return
    const newUserMessageCount = messages.filter(message => message.role === 'user').length
    if (!forceReview && newUserMessageCount < this.reviewEveryUserMessages) return

    const previousSummary = await this.store.getLatestSummary({ sessionId: identity.sessionId })
    const extraction = await extractor.extract({ ...identity, previousSummary, messages })
    for (const operation of extraction.nodes) {
      if (operation.operation === 'ignore') continue
      await this.proposeUpdate({
        operation: operation.operation,
        kind: operation.kind,
        itemKey: operation.itemKey,
        targetId: operation.targetId,
        expectedRevision: operation.expectedRevision,
        node: {
          ...operation.node,
          sourceMessageIds: operation.node.sourceMessageIds?.length
            ? operation.node.sourceMessageIds
            : messages.map(message => message.id),
        },
        reason: operation.reason,
        actor: 'memory-extractor',
        explicitUserIntent: operation.explicitUserIntent,
        identity,
      })
    }

    const sinceSummary = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastSummaryMessageId,
      limit: 500,
    })
    let lastSummaryMessageId = state?.lastSummaryMessageId
    if (extraction.summaryPatch) {
      const summary = buildSummary(identity.sessionId, previousSummary, sinceSummary, extraction)
      await this.store.appendSummary(summary)
      await this.store.appendAuditEvent({
        id: randomUUID(),
        eventType: 'summary',
        sessionId: identity.sessionId,
        profileId: identity.profileId || 'default',
        actor: 'memory-extractor',
        reason: extraction.fallbackReason ? 'Periodic chained summary (safe fallback)' : 'Periodic chained summary',
        payload: {
          summaryId: summary.id,
          fromMessageId: summary.fromMessageId,
          toMessageId: summary.toMessageId,
          ...(extraction.fallbackReason ? { fallbackReason: extraction.fallbackReason } : {}),
        },
        createdAt: summary.createdAt,
      })
      lastSummaryMessageId = sinceSummary.at(-1)?.id
    }
    const lastExtractedMessageId = messages.at(-1)?.id
    await this.store.setSessionState({
      sessionId: identity.sessionId,
      lastExtractedMessageId,
      lastSummaryMessageId,
      updatedAt: new Date().toISOString(),
    })
    await this.store.appendAuditEvent({
      id: randomUUID(),
      eventType: 'extract',
      sessionId: identity.sessionId,
      profileId: identity.profileId || 'default',
      actor: 'memory-extractor',
      reason: extraction.fallbackReason
        ? 'Processed new conversation messages using safe fallback'
        : 'Processed new conversation messages',
      payload: {
        fromMessageId: messages[0].id,
        toMessageId: lastExtractedMessageId,
        operations: extraction.nodes.length,
        ...(extraction.fallbackReason ? { fallbackReason: extraction.fallbackReason } : {}),
      },
      createdAt: new Date().toISOString(),
    })
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
  }
}

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
  return (identity?.profileId || 'default') === node.profileId
}
