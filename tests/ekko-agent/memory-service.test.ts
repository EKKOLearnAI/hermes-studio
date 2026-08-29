import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  EkkoDatabaseManager,
  MemoryService,
  ModelMemoryExtractor,
  SqliteMemoryStore,
  createMemoryTools,
  resolveMemoryQuery,
  type MemoryNode,
  type MemoryMessage,
  type MemoryStore,
  type ModelClient,
  type ModelRequest,
} from '../../packages/ekko-agent/src'

let webUiHome = ''
let store: SqliteMemoryStore
let service: MemoryService

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-memory-service-'))
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ baseDirectory: webUiHome }))
  service = new MemoryService({ store, reviewEveryUserMessages: 1 })
})

afterEach(async () => {
  service.close()
  await rm(webUiHome, { recursive: true, force: true })
})

describe('MemoryService', () => {
  it('keeps identical canonical keys independent across profile, context, and session scopes', async () => {
    const contextA = { type: 'context' as const, namespace: 'test.chat', id: 'conversation-a' }
    const contextB = { type: 'context' as const, namespace: 'test.chat', id: 'conversation-b' }
    const profile = { type: 'profile' as const }
    const session = { type: 'session' as const, id: 'runtime-a' }
    const createLocation = async (scope: typeof profile | typeof contextA | typeof contextB | typeof session, value: string) => service.proposeUpdate({
      operation: 'create',
      kind: 'home_location',
      scope,
      reason: `Store ${value} in its declared scope.`,
      explicitUserIntent: true,
      identity: {
        sessionId: 'runtime-a',
        profileId: 'default',
        recallScopes: [profile, contextA, contextB, session],
        writeScopes: [profile, contextA, contextB, session],
        defaultWriteScope: scope,
        origin: { host: 'test-host', namespace: 'chat', contextId: scope.type === 'context' ? scope.id : 'runtime-a' },
      },
      node: { valueJson: value, title: `常住地：${value}`, content: `用户常住在${value}。` },
    })

    const profileNode = await createLocation(profile, '上海')
    const contextANode = await createLocation(contextA, '北京')
    const contextBNode = await createLocation(contextB, '广州')
    const sessionNode = await createLocation(session, '杭州')

    expect([profileNode, contextANode, contextBNode, sessionNode])
      .toEqual(expect.arrayContaining([expect.objectContaining({ accepted: true, action: 'created' })]))
    await expect(service.list({ profileId: 'default', key: 'profile.location.home' }))
      .resolves.toHaveLength(4)

    const currentConversation = await service.search({
      sessionId: 'runtime-a',
      profileId: 'default',
      recallScopes: [profile, contextA, session],
    }, { kinds: ['home_location'], limit: 10 })
    expect(currentConversation.exact.map(node => node.valueJson)).toEqual(expect.arrayContaining(['上海', '北京', '杭州']))
    expect(currentConversation.exact.map(node => node.valueJson)).not.toContain('广州')

    const legacyCaller = await service.search(
      { sessionId: 'legacy-runtime', profileId: 'default' },
      { kinds: ['home_location'], limit: 10 },
    )
    expect(legacyCaller.exact.map(node => node.valueJson)).toEqual(['上海'])
    await expect(service.get(contextANode.nodeId!, {
      sessionId: 'legacy-runtime',
      profileId: 'default',
    })).resolves.toBeUndefined()
    await expect(service.get(contextANode.nodeId!, { profileId: 'default' }))
      .resolves.toMatchObject({ valueJson: '北京', scope: contextA })
    expect(contextANode.node).toMatchObject({
      scope: contextA,
      origin: { host: 'test-host', namespace: 'chat', contextId: 'conversation-a' },
    })
  })

  it('migrates version-3 nodes to profile scope without deleting them', async () => {
    const manager = new EkkoDatabaseManager({ databasePath: join(webUiHome, 'legacy-memory.db') })
    manager.connection.exec(`
      CREATE TABLE memory_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        parent_id TEXT,
        supersedes_id TEXT,
        profile_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        category_path_json TEXT NOT NULL,
        category_path_text TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        value_json TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE UNIQUE INDEX idx_memory_nodes_unique_active_key
        ON memory_nodes (profile_id, key) WHERE status = 'active';
    `)
    manager.connection.prepare(
      'INSERT INTO schema_migrations (component, version, applied_at) VALUES (?, ?, ?)',
    ).run('memory', 3, '2026-01-01T00:00:00.000Z')
    manager.connection.prepare(`
      INSERT INTO memory_nodes (
        id, profile_id, domain, category_path_json, category_path_text, type, key,
        revision, value_json, title, content, status, confidence, importance,
        tags_json, entities_json, source_message_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-node', 'default', 'profile', '["location"]', 'location', 'fact',
      'profile.location.home', 1, '"\u82cf\u5dde"', '常住地', '用户常住苏州。', 'active', 0.9, 0.8,
      '[]', '["\u82cf\u5dde"]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )

    const migrated = new SqliteMemoryStore(manager)
    try {
      await expect(migrated.getNode('legacy-node')).resolves.toMatchObject({
        id: 'legacy-node',
        scope: { type: 'profile' },
        valueJson: '苏州',
      })
      expect(manager.connection.prepare(
        'SELECT 1 AS applied FROM schema_migrations WHERE component = ? AND version = ?',
      ).get('memory', 4)).toMatchObject({ applied: 1 })
    } finally {
      migrated.close()
    }
  })

  it('exposes standalone CRUD, history, and audit methods', async () => {
    const identity = { sessionId: 'memory-api', profileId: 'default' }
    const messageIds = await service.captureMessages(identity, [
      { role: 'user', content: 'I prefer a dark interface.' },
      { role: 'assistant', content: 'I will remember that.' },
    ])

    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'interface_theme',
      reason: 'Explicit user preference.',
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'dark',
        title: 'Interface theme',
        content: 'The user prefers a dark interface.',
        sourceMessageIds: [messageIds[0]],
      },
    })
    expect(created).toMatchObject({ accepted: true, action: 'created' })

    const active = await service.list({ profileId: 'default' })
    expect(active).toMatchObject([{ id: created.nodeId, status: 'active', revision: 1 }])
    await expect(service.get(created.nodeId!, identity)).resolves.toMatchObject({ valueJson: 'dark' })

    const updated = await service.update(created.nodeId!, {
      reason: 'The user changed the preference.',
      expectedRevision: created.node!.revision,
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'light',
        title: 'Interface theme',
        content: 'The user prefers a light interface.',
      },
    })
    expect(updated).toMatchObject({ accepted: true, action: 'updated', node: { revision: 2, valueJson: 'light' } })
    await expect(service.list({
      profileId: 'default',
      statuses: ['superseded'],
    })).resolves.toMatchObject([{ id: created.nodeId, status: 'superseded' }])

    const messages = await service.listMessages({ sessionId: identity.sessionId, limit: 10 })
    expect(messages.map(message => message.id)).toEqual(messageIds)
    const updatedAt = new Date().toISOString()
    await store.appendSummary({
      id: 'memory-api-summary',
      sessionId: identity.sessionId,
      fromMessageId: messageIds[0],
      toMessageId: messageIds[1],
      summary: 'The user selected an interface theme.',
      constraints: [],
      preferences: ['Interface theme'],
      decisions: [],
      completedWork: [],
      pendingWork: [],
      knownIssues: [],
      createdAt: updatedAt,
    })
    await store.setSessionState({
      sessionId: identity.sessionId,
      lastExtractedMessageId: messageIds[1],
      lastSummaryMessageId: messageIds[1],
      updatedAt,
    })
    await expect(service.getLatestSummary(identity.sessionId)).resolves.toMatchObject({ id: 'memory-api-summary' })
    await expect(service.getSessionState(identity.sessionId)).resolves.toMatchObject({
      lastExtractedMessageId: messageIds[1],
      lastSummaryMessageId: messageIds[1],
    })

    const removed = await service.delete(updated.nodeId!, {
      reason: 'The user asked Ekko to forget this preference.',
      expectedRevision: updated.node!.revision,
      identity,
    })
    expect(removed).toMatchObject({ mode: 'soft', deletedIds: [updated.nodeId] })
    await expect(service.list({
      profileId: 'default',
      statuses: ['deleted'],
    })).resolves.toMatchObject([{ id: updated.nodeId, status: 'deleted', revision: 3 }])

    const audits = await service.listAuditEvents({
      profileId: 'default',
      sessionId: identity.sessionId,
    })
    expect(audits.map(event => event.eventType)).toEqual(['delete', 'supersede', 'create'])
    expect(audits.every(event => event.profileId === 'default')).toBe(true)
  })

  it('requires confirmation for the exported hard-delete method', async () => {
    const identity = { sessionId: 'memory-hard-delete', profileId: 'default' }
    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'temporary_note',
      reason: 'Store a temporary fact.',
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'temporary',
        title: 'Temporary note',
        content: 'A temporary note.',
      },
    })
    expect(created).toMatchObject({ accepted: true, action: 'created' })

    const unconfirmed = await service.delete(created.nodeId!, {
      mode: 'hard',
      reason: 'Remove the temporary fact.',
      expectedRevision: created.node!.revision,
      identity,
    })
    expect(unconfirmed).toEqual({
      deletedIds: [],
      mode: 'hard',
      requiresConfirmation: true,
      reason: 'Hard delete requires confirmation.',
    })
    await expect(service.delete(created.nodeId!, {
      mode: 'hard',
      confirmed: true,
      reason: 'Remove the temporary fact.',
      expectedRevision: created.node!.revision,
      identity,
    })).resolves.toMatchObject({ mode: 'hard', deletedIds: [created.nodeId] })
    await expect(service.get(created.nodeId!, identity)).resolves.toBeUndefined()
  })


  it('keeps the latest 20 messages in automatic memory context by default', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.captureMessages(identity, Array.from({ length: 25 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index + 1}`,
    })))

    const context = await service.retrieve(identity)

    expect(context.recentMessages).toHaveLength(20)
    expect(context.recentMessages[0]?.content).toBe('message-6')
    expect(context.recentMessages.at(-1)?.content).toBe('message-25')
  })

  it('generates canonical keys on the server and stores one profile memory shape', async () => {
    const accepted = await service.proposeUpdate({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: 'tofu',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'work' },
      node: userPreference('tofu'),
    })
    expect(accepted).toMatchObject({
      accepted: true,
      action: 'created',
      node: { key: 'preference.food.avoid:tofu', revision: 1 },
    })
    const exact = await service.search(
      { sessionId: 's1', profileId: 'work' },
      { domain: 'preference', key: 'preference.food.avoid:tofu', valueJson: 'tofu' },
    )
    expect(exact.exact).toMatchObject([{ profileId: 'work', valueJson: 'tofu' }])
  })

  it('searches controlled memory kinds without relying on natural-language matching', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.proposeUpdate({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'visual_theme',
      reason: '用户陈述稳定偏好。',
      identity,
      node: {
        valueJson: '深色界面',
        title: '界面主题偏好',
        content: '用户偏好使用深色界面。',
      },
    })
    await service.proposeUpdate({
      operation: 'create',
      kind: 'habit_routine',
      itemKey: 'weekly_review',
      reason: '用户陈述固定习惯。',
      identity,
      node: {
        valueJson: '每周复盘',
        title: '复盘习惯',
        content: '用户保持每周复盘的习惯。',
      },
    })
    await service.proposeUpdate({
      operation: 'create',
      kind: 'home_location',
      reason: '用户陈述常住地。',
      identity,
      node: { valueJson: '测试城市', title: '用户常住地', content: '用户常住在测试城市。' },
    })

    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_search')!
    const result = await tool.execute({
      kinds: ['general_preference', 'habit_routine'],
      limit: 10,
    }, identity)

    expect(result.ok).toBe(true)
    expect((result.data as { exact: MemoryNode[] }).exact.map(node => node.key).sort()).toEqual([
      'preference.general:visual_theme',
      'profile.habit:weekly_review',
    ])
  })

  it('prefers corrections when resolving unified-memory conflicts', () => {
    const nodes = [
      memoryNode('older'),
      memoryNode('newer', { updatedAt: '2026-01-02T00:00:00.000Z' }),
      memoryNode('correction', { type: 'correction' }),
    ]
    const result = resolveMemoryQuery([], nodes, undefined, 10)
    expect(result.relevant.map(node => node.id)).toEqual(['correction'])
    expect(result.omitted).toEqual(expect.arrayContaining([
      { nodeId: 'older', reason: 'conflict_lost' },
      { nodeId: 'newer', reason: 'conflict_lost' },
    ]))
  })

  it('uses a 4000-token budget instead of a fixed automatic card count', async () => {
    for (let index = 0; index < 60; index += 1) {
      await store.upsertNode(memoryNode(`budget-${index}`, {
        type: 'constraint',
        key: `constraint.hard:budget_${index}`,
        title: `Budget preference ${index}`,
        content: `Preference ${index}: ${'compact detail '.repeat(80)}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }))
    }

    const context = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'unrelated current request',
    )

    expect(context.relevantNodes.length).toBeGreaterThan(12)
    expect(context.relevantNodes.length).toBeLessThan(60)
    expect(context.diagnostics).toMatchObject({
      tokenBudget: 4000,
      retrievedNodeCount: context.relevantNodes.length,
    })
    expect(context.diagnostics.usedTokens).toBeLessThanOrEqual(4000)
    expect(context.diagnostics.omittedNodeCount).toBe(60 - context.relevantNodes.length)
  })

  it('finds relevant old facts outside the former importance-based candidate window', async () => {
    await store.upsertNode(memoryNode('needle', {
      type: 'fact',
      key: 'custom.fact:needle',
      title: 'Archived deployment codename',
      content: 'The archived deployment codename is needle-orchid.',
      importance: 0.01,
      confidence: 0.4,
      updatedAt: '2020-01-01T00:00:00.000Z',
    }))
    for (let index = 0; index < 180; index += 1) {
      await store.upsertNode(memoryNode(`noise-${index}`, {
        type: 'fact',
        key: `custom.fact:noise_${index}`,
        title: `Recent unrelated fact ${index}`,
        content: `Recent unrelated content ${index}`,
        importance: 1,
        confidence: 1,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }))
    }

    const context = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'needle-orchid',
    )

    expect(context.relevantNodes.map(node => node.id)).toContain('needle')
  })

  it('recalls ordinary preferences only when they match the current request', async () => {
    await service.proposeUpdate({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'interface_theme',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'default' },
      node: {
        valueJson: 'dark interface',
        title: 'Interface theme',
        content: 'The user prefers a dark interface.',
      },
    })

    const unrelated = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'Plan a weekend trip',
    )
    const related = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'Configure the dark interface',
    )

    expect(unrelated.relevantNodes).toHaveLength(0)
    expect(related.relevantNodes.map(node => node.key)).toContain('preference.general:interface_theme')
  })

  it('defaults and clamps direct memory searches to 50 results at runtime', async () => {
    for (let index = 0; index < 60; index += 1) {
      await store.upsertNode(memoryNode(`search-${index}`, {
        key: `preference.general:search_${index}`,
      }))
    }

    const identity = { sessionId: 's1', profileId: 'default' }
    const defaultResult = await service.search(identity, {})
    const result = await service.search(identity, { limit: 999 })

    expect([...defaultResult.exact, ...defaultResult.relevant]).toHaveLength(50)
    expect([...result.exact, ...result.relevant]).toHaveLength(50)
  })

  it('keeps independent multi-value preferences and isolates profiles', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        kind: 'food_avoidance',
        itemKey: value,
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', profileId: 'work' },
        node: userPreference(value),
      })
    }
    const result = await service.search({ sessionId: 's1', profileId: 'work' }, { domain: 'preference', limit: 10 })
    const nodes = [...result.exact, ...result.relevant]
    expect(nodes.map(node => node.valueJson).sort()).toEqual(['芹菜', '香菜'])
    await expect(service.get(nodes[0].id, { sessionId: 'other', profileId: 'personal' })).resolves.toBeUndefined()
    await expect(service.forget({
      id: nodes[0].id,
      reason: 'cross-profile attempt',
      identity: { sessionId: 'other', profileId: 'personal' },
    })).resolves.toMatchObject({ deletedIds: [], reason: 'No matching memory was found.' })

    await expect(service.proposeUpdate({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: '葱',
      reason: 'cross-profile attempt',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'work' },
      node: { ...userPreference('葱'), profileId: 'personal' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'Memory profileId does not match the runtime identity.',
    })
  })

  it('extracts explicit preferences asynchronously and builds chained summaries', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    service.scheduleRunCompletion(identity, [
      { role: 'user', content: '以后做饭少油少辣' },
      { role: 'assistant', content: '好的，已记住。' },
    ])
    await service.drain()

    const result = await service.search(identity, { domain: 'preference', key: 'preference.general:food_flavor_profile' })
    expect([...result.exact, ...result.relevant]).toMatchObject([{
      profileId: 'default',
      valueJson: { oil: 'low', spicy: 'low' },
    }])
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      currentGoal: '以后做饭少油少辣',
    })
  })

  it('stores every turn and runs independent review and summary passes at the user-message threshold', async () => {
    const extract = vi.fn().mockResolvedValue({
      summaryPatch: 'Two user turns were reviewed together.',
      nodes: [],
    })
    const gated = new MemoryService({
      store,
      reviewEveryUserMessages: 2,
      extractor: { extract },
    })
    const identity = { sessionId: 'threshold-session', profileId: 'default' }

    gated.scheduleRunCompletion(identity, [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ])
    await gated.drain()

    expect(extract).not.toHaveBeenCalled()
    await expect(store.listMessagesAfter({ sessionId: identity.sessionId, limit: 10 }))
      .resolves.toHaveLength(2)
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toBeUndefined()

    gated.scheduleRunCompletion(identity, [
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ])
    await gated.drain()

    expect(extract).toHaveBeenCalledTimes(2)
    expect(extract.mock.calls[0][0].messages.map((message: MemoryMessage) => message.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
    expect(extract.mock.calls[0][0].reviewRequest).toEqual({ trigger: 'periodic' })
    expect(extract.mock.calls[1][0].reviewRequest).toBeUndefined()
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
      summary: 'Two user turns were reviewed together.',
    })
  })

  it('advances review and summary cursors independently when both background passes overlap', async () => {
    let releaseReview!: () => void
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve })
    const reviewer = {
      extract: vi.fn(async () => {
        await reviewGate
        return { nodes: [] }
      }),
    }
    const summarizer = {
      extract: vi.fn().mockResolvedValue({ summaryPatch: 'Independent summary.', nodes: [] }),
    }
    const overlapping = new MemoryService({ store, reviewEveryUserMessages: 1 })
    const identity = { sessionId: 'overlapping-cursors', profileId: 'default' }
    overlapping.scheduleRunCompletion(
      identity,
      [{ role: 'user', content: 'one durable message' }],
      reviewer,
      { summaryExtractor: summarizer },
    )
    await vi.waitFor(async () => {
      await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
        summary: 'Independent summary.',
      })
    })
    releaseReview()
    await overlapping.drain()

    const [message] = await store.listMessagesAfter({ sessionId: identity.sessionId, limit: 10 })
    await expect(store.getSessionState(identity.sessionId)).resolves.toMatchObject({
      lastReviewedMessageId: message.id,
      lastSummaryMessageId: message.id,
    })
  })

  it('batches ordinary turns at the default review interval', async () => {
    const extract = vi.fn().mockResolvedValue({ summaryPatch: 'Default batched review.', nodes: [] })
    const responsive = new MemoryService({ store, extractor: { extract } })

    for (let turn = 1; turn <= 7; turn += 1) {
      responsive.scheduleRunCompletion(
        { sessionId: 'default-review-session', profileId: 'default' },
        [
          { role: 'user', content: `ordinary question ${turn}` },
          { role: 'assistant', content: `ordinary answer ${turn}` },
        ],
      )
    }
    await responsive.drain()
    expect(extract).not.toHaveBeenCalled()

    responsive.scheduleRunCompletion(
      { sessionId: 'default-review-session', profileId: 'default' },
      [
        { role: 'user', content: 'ordinary question 8' },
        { role: 'assistant', content: 'ordinary answer 8' },
      ],
    )
    await responsive.drain()

    expect(extract).toHaveBeenCalledTimes(2)
  })

  it('allows a manual review to bypass the user-message threshold', async () => {
    const extract = vi.fn().mockResolvedValue({ summaryPatch: 'Manual review.', nodes: [] })
    const gated = new MemoryService({
      store,
      reviewEveryUserMessages: 8,
      extractor: { extract },
    })
    const identity = { sessionId: 'manual-review-session', profileId: 'default' }
    await gated.captureMessages(identity, [{ role: 'user', content: 'one message' }])

    gated.scheduleExtraction(identity)
    await gated.drain()

    expect(extract).toHaveBeenCalledTimes(1)
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toBeUndefined()
  })

  it('persists a failed review and resumes the same job after an application restart', async () => {
    const identity = { sessionId: 'restart-review-session', profileId: 'default' }
    const [throughMessageId] = await service.captureMessages(identity, [
      { role: 'user', content: '请记住我偏好简短回答' },
    ])
    await service.scheduleReview({
      identity,
      throughMessageId,
      request: { trigger: 'review' },
      preferredProvider: 'removed-provider',
      preferredModel: 'removed-model',
      extractor: { extract: vi.fn().mockRejectedValue(new Error('provider unavailable')) },
    })
    await service.drain()

    expect(store.databaseManager.connection.prepare(
      'SELECT status, attempt FROM memory_review_jobs WHERE session_id = ?',
    ).get(identity.sessionId)).toMatchObject({ status: 'retry', attempt: 1 })
    await expect(service.getSessionState(identity.sessionId)).resolves.toBeUndefined()

    service.close()
    store = new SqliteMemoryStore(new EkkoDatabaseManager({ baseDirectory: webUiHome }))
    const resumedExtract = vi.fn().mockResolvedValue({ nodes: [] })
    service = new MemoryService({
      store,
      reviewExtractorResolver: async () => ({
        provider: 'current-provider',
        model: 'current-model',
        extractor: { extract: resumedExtract },
      }),
    })
    await service.recoverReviewJobs()
    await vi.waitFor(() => {
      expect(store.databaseManager.connection.prepare(
        'SELECT status FROM memory_review_jobs WHERE session_id = ?',
      ).get(identity.sessionId)).toMatchObject({ status: 'completed' })
    })
    await service.drain()

    expect(resumedExtract).toHaveBeenCalledTimes(1)
    expect(resumedExtract.mock.calls[0][0]).toMatchObject({
      sessionId: identity.sessionId,
      reviewRequest: { trigger: 'review' },
    })
    expect(store.databaseManager.connection.prepare(
      'SELECT COUNT(*) AS count, MAX(attempt) AS attempt FROM memory_review_jobs WHERE session_id = ?',
    ).get(identity.sessionId)).toMatchObject({ count: 1, attempt: 2 })
    await expect(service.getSessionState(identity.sessionId)).resolves.toMatchObject({
      lastReviewedMessageId: throughMessageId,
      lastSummaryMessageId: undefined,
    })
  })

  it('uses the host resolver instead of a stale profile model cached by an earlier run', async () => {
    const profileId = 'changed-provider-profile'
    const identity = { sessionId: 'changed-provider-session', profileId }
    const staleExtract = vi.fn().mockRejectedValue(new Error('deleted provider credentials'))
    const currentExtract = vi.fn().mockResolvedValue({ nodes: [] })
    service = new MemoryService({
      store,
      reviewExtractorResolver: async () => ({
        provider: 'current-provider',
        model: 'current-model',
        extractor: { extract: currentExtract },
      }),
    })
    service.registerReviewExtractor(profileId, {
      provider: 'deleted-provider',
      model: 'deleted-model',
      extractor: { extract: staleExtract },
    })
    const [throughMessageId] = await service.captureMessages(identity, [{
      role: 'user',
      content: '请记住我喜欢简短回答',
    }])

    await service.scheduleReview({
      identity,
      throughMessageId,
      request: { trigger: 'review' },
      preferredProvider: 'deleted-provider',
      preferredModel: 'deleted-model',
    })
    await vi.waitFor(() => expect(store.databaseManager.connection.prepare(
      'SELECT status FROM memory_review_jobs WHERE session_id = ?',
    ).get(identity.sessionId)).toMatchObject({ status: 'completed' }))
    await service.drain()

    expect(currentExtract).toHaveBeenCalledTimes(1)
    expect(staleExtract).not.toHaveBeenCalled()
  })

  it('does not cap reviewer output tokens and retries provider-truncated reviews', async () => {
    const identity = { sessionId: 'truncated-review-session', profileId: 'default' }
    const [throughMessageId] = await service.captureMessages(identity, [{
      role: 'user',
      content: '我住在厦门。',
    }])
    const create = vi.fn(async () => ({
      content: '',
      finishReason: 'length' as const,
    }))
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    await service.scheduleReview({
      identity,
      throughMessageId,
      request: { trigger: 'review' },
      extractor: new ModelMemoryExtractor({
        mode: 'review',
        modelClient: client,
        memory: service,
        fallback: false,
      }),
    })
    await service.drain()

    expect((create.mock.calls[0][0] as ModelRequest).maxTokens).toBeUndefined()
    expect(store.databaseManager.connection.prepare(
      'SELECT status, last_error FROM memory_review_jobs WHERE session_id = ?',
    ).get(identity.sessionId)).toMatchObject({
      status: 'retry',
      last_error: expect.stringContaining('truncated by the model provider'),
    })
    await expect(service.getSessionState(identity.sessionId)).resolves.toBeUndefined()
  })

  it('times out a hung review attempt and continues the serial queue without waiting for the model retry stack', async () => {
    service = new MemoryService({ store, reviewAttemptTimeoutMs: 25 })
    const profileId = 'timeout-profile'
    const firstIdentity = { sessionId: 'hung-review-session', profileId }
    const secondIdentity = { sessionId: 'next-review-session', profileId }
    const [firstThrough] = await service.captureMessages(firstIdentity, [{ role: 'user', content: 'first fact' }])
    const [secondThrough] = await service.captureMessages(secondIdentity, [{ role: 'user', content: 'second fact' }])
    const first = vi.fn((input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true })
    }))
    const second = vi.fn().mockResolvedValue({ nodes: [] })

    await service.scheduleReview({
      identity: firstIdentity,
      throughMessageId: firstThrough,
      request: { trigger: 'review' },
      extractor: { extract: first },
    })
    await service.scheduleReview({
      identity: secondIdentity,
      throughMessageId: secondThrough,
      request: { trigger: 'review' },
      extractor: { extract: second },
    })
    await service.drain()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(store.databaseManager.connection.prepare(
      'SELECT status, last_error FROM memory_review_jobs WHERE session_id = ?',
    ).get(firstIdentity.sessionId)).toMatchObject({
      status: 'retry',
      last_error: expect.stringContaining('timed out after 25ms'),
    })
    expect(store.databaseManager.connection.prepare(
      'SELECT status FROM memory_review_jobs WHERE session_id = ?',
    ).get(secondIdentity.sessionId)).toMatchObject({ status: 'completed' })
  })

  it('requeues a stale running review when the status page checks it', async () => {
    const identity = { sessionId: 'stale-review-session', profileId: 'stale-profile' }
    const [throughMessageId] = await service.captureMessages(identity, [{ role: 'user', content: 'stale fact' }])
    const job = await store.enqueueReviewJob({
      id: 'stale-review-job',
      profileId: identity.profileId,
      sessionId: identity.sessionId,
      throughMessageId,
      identity,
      request: { trigger: 'review' },
      createdAt: '2026-08-29T00:00:00.000Z',
    })
    await store.updateReviewJob(job.id, {
      status: 'running',
      lockedAt: '2026-08-29T00:00:00.000Z',
    })
    const extract = vi.fn().mockResolvedValue({ nodes: [] })
    service = new MemoryService({
      store,
      reviewExtractorResolver: async () => ({ extractor: { extract } }),
    })

    await service.getReviewStatus(identity.profileId)
    await vi.waitFor(() => expect(store.databaseManager.connection.prepare(
      'SELECT status FROM memory_review_jobs WHERE id = ?',
    ).get(job.id)).toMatchObject({ status: 'completed' }))

    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('makes itemKey requirements explicit and lets the reviewer correct a rejected create in the same review', async () => {
    const sourceMessageId = 'project-owner-message'
    const create = vi.fn(async (request: ModelRequest) => {
      const call = create.mock.calls.length
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'invalid-project-create',
            name: 'memory_propose_update',
            arguments: {
              operation: 'create',
              kind: 'project_context',
              reason: '用户明确说明 Hermes Studio 是自己的开源项目。',
              explicitUserIntent: false,
              node: {
                valueJson: { repository: 'EKKOLearnAI/hermes-studio', owner: true },
                title: '用户的开源项目 Hermes Studio',
                content: 'Hermes Studio 是用户的开源项目。',
                sourceMessageIds: [sourceMessageId],
              },
            },
          }],
        }
      }
      if (call === 2) {
        expect(request.messages.some(message => (
          message.role === 'tool' && String(message.content).includes('itemKey is required')
        ))).toBe(true)
        return {
          content: '',
          toolCalls: [{
            id: 'corrected-project-create',
            name: 'memory_propose_update',
            arguments: {
              operation: 'create',
              kind: 'project_context',
              itemKey: 'hermes_studio',
              reason: '用户明确说明 Hermes Studio 是自己的开源项目。',
              explicitUserIntent: false,
              node: {
                valueJson: { repository: 'EKKOLearnAI/hermes-studio', owner: true },
                title: '用户的开源项目 Hermes Studio',
                content: 'Hermes Studio 是用户的开源项目。',
                sourceMessageIds: [sourceMessageId],
              },
            },
          }],
        }
      }
      return { content: 'Review complete.' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const reviewer = new ModelMemoryExtractor({
      mode: 'review',
      modelClient: client,
      memory: service,
      fallback: false,
    })

    await reviewer.extract({
      sessionId: 'project-review-correction',
      profileId: 'default',
      messages: [memoryMessage('user', 'https://github.com/EKKOLearnAI/hermes-studio 这是我的开源项目', sourceMessageId)],
      reviewRequest: { trigger: 'review' },
    })

    const definition = createMemoryTools(service)
      .find(tool => tool.definition.name === 'memory_propose_update')!.definition
    expect(definition.description).toContain('itemKey is REQUIRED')
    expect(JSON.stringify(definition.parameters)).toContain('kind=project_context, itemKey=hermes_studio')
    await expect(service.search(
      { sessionId: 'project-review-correction', profileId: 'default' },
      { key: 'project.context:hermes_studio' },
    )).resolves.toMatchObject({
      exact: [expect.objectContaining({
        key: 'project.context:hermes_studio',
        valueJson: { repository: 'EKKOLearnAI/hermes-studio', owner: true },
      })],
    })
  })

  it('does not let a successful parallel mutation hide another rejected reviewer tool call', async () => {
    const client = modelClient()
    vi.mocked(client.create)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'invalid-project',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create', kind: 'project_context', reason: 'missing item key',
            node: { title: 'Project', content: 'User project.' },
          },
        }, {
          id: 'valid-location',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create', kind: 'home_location', reason: 'explicit location',
            node: { valueJson: '厦门', title: '所在地', content: '用户住在厦门。' },
          },
        }],
      })
      .mockResolvedValueOnce({ content: 'Done without correcting the rejected call.' })
    const reviewer = new ModelMemoryExtractor({
      mode: 'review', modelClient: client, memory: service, fallback: false,
    })

    await expect(reviewer.extract({
      sessionId: 'parallel-tool-error',
      profileId: 'default',
      messages: [memoryMessage('user', '这是我的项目，我住在厦门。', 'parallel-source')],
      reviewRequest: { trigger: 'review' },
    })).rejects.toThrow('did not correct rejected tool calls')
  })

  it('runs review jobs serially per profile while keeping each Session in a separate model call', async () => {
    let active = 0
    let maxActive = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const reviewedSessions: string[] = []
    const extractor = {
      extract: vi.fn(async (input: { sessionId: string }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        reviewedSessions.push(input.sessionId)
        if (input.sessionId === 'serial-session-a') await firstGate
        active -= 1
        return { nodes: [] }
      }),
    }
    const identityA = { sessionId: 'serial-session-a', profileId: 'serial-profile' }
    const identityB = { sessionId: 'serial-session-b', profileId: 'serial-profile' }
    const [throughA] = await service.captureMessages(identityA, [{ role: 'user', content: 'A durable fact' }])
    const [throughB] = await service.captureMessages(identityB, [{ role: 'user', content: 'B durable fact' }])
    await service.scheduleReview({ identity: identityA, throughMessageId: throughA, request: { trigger: 'review' }, extractor })
    await service.scheduleReview({ identity: identityB, throughMessageId: throughB, request: { trigger: 'review' }, extractor })
    await vi.waitFor(() => expect(reviewedSessions).toEqual(['serial-session-a']))
    await expect(service.getReviewStatus('serial-profile')).resolves.toMatchObject({
      reviewing: true,
      activeJobs: 2,
      pending: 1,
      running: 1,
    })
    releaseFirst()
    await service.drain()

    expect(maxActive).toBe(1)
    expect(reviewedSessions).toEqual(['serial-session-a', 'serial-session-b'])
    expect(extractor.extract).toHaveBeenCalledTimes(2)
    await expect(service.getReviewStatus('serial-profile')).resolves.toMatchObject({
      reviewing: false,
      activeJobs: 0,
      pending: 0,
      running: 0,
      latestCompletedAt: expect.any(String),
    })
  })

  it('reviews a large pending Session in bounded batches through the job target', async () => {
    const identity = { sessionId: 'batched-review-session', profileId: 'default' }
    const ids = await service.captureMessages(
      identity,
      Array.from({ length: 45 }, (_, index) => ({
        role: 'user' as const,
        content: `durable message ${index + 1}`,
      })),
    )
    const extract = vi.fn().mockResolvedValue({ nodes: [] })
    await service.scheduleReview({
      identity,
      throughMessageId: ids.at(-1)!,
      request: { trigger: 'review' },
      extractor: { extract },
    })
    await service.drain()

    expect(extract).toHaveBeenCalledTimes(2)
    expect(extract.mock.calls.map(call => call[0].messages.length)).toEqual([40, 5])
    expect(extract.mock.calls.map(call => call[0].reviewRequest)).toEqual([
      { trigger: 'periodic' },
      { trigger: 'review' },
    ])
    await expect(service.getSessionState(identity.sessionId)).resolves.toMatchObject({
      lastReviewedMessageId: ids.at(-1),
    })
  })

  it('executes an exact forget job deterministically without requiring the review model', async () => {
    const identity = { sessionId: 'deterministic-forget-session', profileId: 'default' }
    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'answer_length',
      reason: 'explicit preference',
      explicitUserIntent: true,
      identity,
      node: { valueJson: 'short', title: '回答长度', content: '用户偏好简短回答。' },
    })
    const [throughMessageId] = await service.captureMessages(identity, [
      { role: 'user', content: '请忘记我的回答长度偏好' },
    ])
    const extract = vi.fn().mockRejectedValue(new Error('model unavailable'))
    await service.scheduleReview({
      identity,
      throughMessageId,
      request: {
        trigger: 'forget',
        forget: {
          id: created.nodeId,
          expectedRevision: created.node!.revision,
          mode: 'soft',
          reason: '用户明确要求删除该记忆。',
        },
      },
      extractor: { extract },
    })
    await service.drain()

    await expect(service.get(created.nodeId!, identity)).resolves.toMatchObject({ status: 'deleted' })
    expect(store.databaseManager.connection.prepare(
      'SELECT status FROM memory_review_jobs WHERE session_id = ?',
    ).get(identity.sessionId)).toMatchObject({ status: 'completed' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('lets one user review click confirm and immediately apply a persisted broad deletion job', async () => {
    const identity = { sessionId: 'manual-confirm-review-session', profileId: 'default' }
    for (const itemKey of ['cilantro', 'celery']) {
      await service.create({
        kind: 'food_avoidance',
        itemKey,
        reason: 'explicit avoidance',
        explicitUserIntent: true,
        identity,
        node: { valueJson: itemKey, title: itemKey, content: `Avoid ${itemKey}.` },
      })
    }
    const [throughMessageId] = await service.captureMessages(identity, [{
      role: 'user', content: '删除全部饮食忌口记忆。',
    }])
    const job = await service.scheduleReview({
      identity,
      throughMessageId,
      request: {
        trigger: 'forget',
        forget: { domain: 'preference', mode: 'soft', reason: '用户要求删除全部饮食忌口。' },
      },
    })
    await service.drain()
    expect(store.databaseManager.connection.prepare(
      'SELECT status FROM memory_review_jobs WHERE id = ?',
    ).get(job!.id)).toMatchObject({ status: 'needs_confirmation' })

    await service.reviewJobNow(job!.id, identity.profileId)
    await service.drain()

    expect(store.databaseManager.connection.prepare(
      'SELECT status, request_json FROM memory_review_jobs WHERE id = ?',
    ).get(job!.id)).toMatchObject({
      status: 'completed',
      request_json: expect.stringContaining('"confirmed":true'),
    })
    await expect(store.queryNodes({ profileId: identity.profileId, statuses: ['active'] }))
      .resolves.toEqual([])
  })

  it('keeps distinct exact forget requests from the same evidence message instead of deduplicating them', async () => {
    const identity = { sessionId: 'multiple-exact-forget-session', profileId: 'default' }
    const memories = Array.from({ length: 4 }, (_, index) => memoryNode(`exact-forget-${index}`, {
      key: `custom.fact:exact_forget_${index}`,
      valueJson: `value-${index}`,
    }))
    for (const memory of memories) await store.upsertNode(memory)
    const [throughMessageId] = await service.captureMessages(identity, [{
      role: 'user',
      content: '删除这四条指定记忆。',
    }])
    for (const [index, memory] of memories.entries()) {
      await service.scheduleReview({
        identity,
        throughMessageId,
        request: {
          trigger: 'forget',
          forget: {
            id: memory.id,
            expectedRevision: memory.revision,
            mode: 'soft',
            reason: `删除第 ${index + 1} 条指定记忆。`,
          },
        },
      })
    }
    await service.drain()

    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_review_jobs WHERE session_id = ? AND request_type = 'forget'",
    ).get(identity.sessionId)).toMatchObject({ count: 4 })
    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_nodes WHERE id LIKE 'exact-forget-%' AND status = 'deleted'",
    ).get()).toMatchObject({ count: 4 })
  })

  it('reviews high-signal durable statements immediately without requiring a remember command', async () => {
    const extract = vi.fn().mockResolvedValue({ summaryPatch: 'Memory candidate reviewed.', nodes: [] })
    const responsive = new MemoryService({
      store,
      reviewEveryUserMessages: 8,
      extractor: { extract },
    })
    const statements = [
      '我是你老爷',
      '我不喜欢长篇解释',
      '我的工作流是 TypeScript 和 pnpm',
      '其实我不住厦门，我现在住南宁',
      '忘记我的住址',
    ]

    for (const [index, content] of statements.entries()) {
      responsive.scheduleRunCompletion(
        { sessionId: `high-signal-memory-${index}`, profileId: 'default' },
        [
          { role: 'user', content },
          { role: 'assistant', content: '知道了。' },
        ],
      )
    }
    await responsive.drain()

    expect(extract).toHaveBeenCalledTimes(statements.length)
    expect(extract.mock.calls.map(call => call[0].messages[0].content)).toEqual(statements)
  })

  it('injects retrieved memory and read-only memory tools into foreground runtime requests', async () => {
    await service.proposeUpdate({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: '香菜',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'default' },
      node: userPreference('香菜'),
    })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: service })
    const result = await runtime.run({
      messages: ['推荐一道菜'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', profileId: 'default' },
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[0].content).toContain('## Memory Usage Rules')
    expect(request.messages[0].content).toContain('about to answer that you do not know or remember')
    expect(request.messages[0].content).toContain('call memory_review exactly once')
    expect(request.messages[0].content).toContain('Avoid 香菜')
    expect(request.messages[0].content).toContain('key=preference.food.avoid:香菜 revision=1')
    expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'memory_search', 'memory_get', 'memory_review', 'memory_forget',
    ]))
    expect(request.tools?.map(tool => tool.name)).not.toContain('memory_propose_update')
    expect(result.memoryContext?.usedMemoryIds).toHaveLength(1)
  })

  it('surfaces a safe foreground memory_review tool call before the post-run curator writes', async () => {
    let foregroundCalls = 0
    let reviewCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      if (request.metadata?.purpose === 'ekko-memory-review') {
        reviewCalls += 1
        if (reviewCalls > 1) return { content: 'Review complete.', finishReason: 'stop' }
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'curator-memory-call',
            name: 'memory_propose_update',
            arguments: {
              operation: 'create',
              kind: 'home_location',
              explicitUserIntent: true,
              reason: '用户明确说明当前常住地。',
              node: { valueJson: '贵阳', title: '用户常住地', content: '用户当前常住在贵阳。' },
            },
          }],
        }
      }
      foregroundCalls += 1
      return foregroundCalls === 1
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'foreground-memory-review',
              name: 'memory_review',
              arguments: {},
            }],
          }
        : { content: '已送交记忆审核。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    const runResult = await runtime.run({
      messages: ['请记住我现在常住贵阳'],
      contextKey: 'foreground-source-session',
      toolContext: { sessionId: 'foreground-source-session', profileId: 'default' },
    })
    const foregroundRequests = create.mock.calls
      .map(call => call[0] as ModelRequest)
      .filter(request => request.metadata?.purpose !== 'ekko-memory-review')
    const foregroundReviewRequest = foregroundRequests[0]
    expect(foregroundReviewRequest.toolChoice).toBe('required')
    expect(foregroundReviewRequest.tools?.map(tool => tool.name)).toEqual(['memory_review'])
    const foregroundAnswerRequest = foregroundRequests[1]
    expect((foregroundAnswerRequest.tools || [])
      .map(tool => tool.name)
      .filter(name => ['memory_search', 'memory_get', 'memory_review', 'memory_forget'].includes(name)))
      .toEqual([])
    expect(runResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'memory_review',
        result: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ requested: true, queued: true, jobId: expect.any(String) }),
        }),
      }),
    ]))
    await service.drain()

    const result = await service.search(
      { sessionId: 'foreground-source-session', profileId: 'default' },
      { key: 'profile.location.home' },
    )
    expect(result.exact).toMatchObject([{
      valueJson: '贵阳',
      sourceMessageIds: [expect.any(String)],
    }])
    const sourceId = result.exact[0].sourceMessageIds[0]
    await expect(store.listMessagesAfter({ sessionId: 'foreground-source-session', limit: 10 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({
        id: sourceId,
        role: 'user',
        content: '请记住我现在常住贵阳',
      })]))
  })

  it('queues foreground memory_forget without blocking the run and suppresses the pending exact card from recall', async () => {
    const identity = { sessionId: 'foreground-forget-session', profileId: 'default' }
    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'interface_theme',
      reason: 'explicit preference',
      explicitUserIntent: true,
      identity,
      node: { valueJson: 'dark', title: '界面主题', content: '用户偏好深色界面。' },
    })
    let releaseReview!: () => void
    let reviewStarted!: () => void
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve })
    const started = new Promise<void>(resolve => { reviewStarted = resolve })
    const blockerIdentity = { sessionId: 'foreground-forget-blocker', profileId: 'default' }
    const [blockerMessageId] = await service.captureMessages(blockerIdentity, [{
      role: 'user',
      content: 'Block this profile review worker while the foreground run continues.',
    }])
    await service.scheduleReview({
      identity: blockerIdentity,
      throughMessageId: blockerMessageId,
      request: { trigger: 'review' },
      extractor: {
        extract: async () => {
          reviewStarted()
          await reviewGate
          return { nodes: [] }
        },
      },
    })
    await started
    let foregroundCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      foregroundCalls += 1
      if (foregroundCalls === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'foreground-forget',
            name: 'memory_forget',
            arguments: {
              id: created.nodeId,
              expectedRevision: created.node!.revision,
              mode: 'soft',
              reason: '用户明确要求忘记该偏好。',
            },
          }],
        }
      }
      return { content: '已提交删除审核。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    const run = await runtime.run({
      messages: ['请忘记我的界面主题记忆'],
      contextKey: identity.sessionId,
      toolContext: identity,
    })
    const initialForegroundRequest = create.mock.calls
      .map(call => call[0] as ModelRequest)
      .find(request => request.metadata?.purpose !== 'ekko-memory-review')!
    expect(initialForegroundRequest.toolChoice).toBe('required')
    expect(initialForegroundRequest.tools?.map(tool => tool.name)).toEqual([
      'memory_search', 'memory_get', 'memory_forget',
    ])
    expect(run.output.content).toBe('已提交删除审核。')
    expect(run.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'memory_forget',
        result: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ queued: true, operation: 'forget' }),
        }),
      }),
    ]))
    const pendingRecall = await service.retrieve(identity, undefined, { key: created.node!.key })
    expect(pendingRecall.usedMemoryIds).not.toContain(created.nodeId)
    await expect(service.get(created.nodeId!, identity)).resolves.toMatchObject({ status: 'active' })

    releaseReview()
    await service.drain()
    await expect(service.get(created.nodeId!, identity)).resolves.toMatchObject({ status: 'deleted' })
    expect(create.mock.calls.some(call => (call[0] as ModelRequest).metadata?.purpose === 'ekko-memory-review')).toBe(false)
  })

  it('coalesces repeated foreground forget-all calls into one job and deletes 101 memories without reviewer model calls', async () => {
    const identity = { sessionId: 'foreground-forget-all-session', profileId: 'default' }
    const memories = Array.from({ length: 101 }, (_, index) => memoryNode(`bulk-memory-${index}`, {
      key: `custom.fact:bulk_memory_${index}`,
      valueJson: `value-${index}`,
      title: `Bulk memory ${index}`,
      content: `Bulk memory content ${index}`,
    }))
    for (const memory of memories) await store.upsertNode(memory)

    let foregroundCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      foregroundCalls += 1
      if (foregroundCalls === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: memories.slice(0, 4).map((memory, index) => ({
            id: `foreground-forget-all-${index}`,
            name: 'memory_forget',
            arguments: {
              id: memory.id,
              expectedRevision: memory.revision,
              mode: 'soft',
              reason: `模型错误地枚举了第 ${index + 1} 条记忆。`,
            },
          })),
        }
      }
      return { content: '已提交全部记忆删除审核。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    await runtime.run({
      messages: ['忘记你所有的记忆'],
      contextKey: identity.sessionId,
      toolContext: identity,
    })
    await service.drain()

    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_review_jobs WHERE session_id = ? AND request_type = 'forget'",
    ).get(identity.sessionId)).toMatchObject({ count: 1 })
    expect(store.databaseManager.connection.prepare(
      "SELECT request_json FROM memory_review_jobs WHERE session_id = ? AND request_type = 'forget'",
    ).get(identity.sessionId)).toMatchObject({ request_json: expect.stringContaining('"all":true') })
    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_nodes WHERE profile_id = ? AND status = 'active'",
    ).get(identity.profileId)).toMatchObject({ count: 0 })
    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_nodes WHERE profile_id = ? AND status = 'deleted'",
    ).get(identity.profileId)).toMatchObject({ count: 101 })
    expect(store.databaseManager.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_audit_events WHERE actor = 'memory-reviewer-deterministic' AND event_type = 'delete'",
    ).get()).toMatchObject({ count: 101 })
    expect(create.mock.calls.some(call => (call[0] as ModelRequest).metadata?.purpose === 'ekko-memory-review')).toBe(false)
  })

  it('gives only memory tools to the reviewer and no tools to the independent summarizer', async () => {
    let reviewCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      if (request.metadata?.purpose === 'ekko-memory-review') {
        reviewCalls += 1
        if (reviewCalls > 1) return { content: 'Review complete.' }
        return {
          content: '',
          toolCalls: [{
            id: 'memory-call-1',
            name: 'memory_propose_update',
            arguments: {
              operation: 'create',
              kind: 'workflow_preference',
              itemKey: 'code_examples',
              reason: '用户明确要求长期使用 TypeScript 代码示例。',
              explicitUserIntent: true,
              node: {
                valueJson: 'TypeScript',
                title: '代码示例语言偏好',
                content: '以后的代码示例优先使用 TypeScript。',
                confidence: 0.98,
                importance: 0.9,
              },
            },
          }],
        }
      }
      if (request.metadata?.purpose === 'ekko-memory-summary') {
        return {
          content: JSON.stringify({
            recentTopic: '设置 TypeScript 代码示例偏好',
            currentGoal: '',
            constraints: ['不使用 JavaScript 代码示例'],
            preferences: ['优先使用 TypeScript 代码示例'],
            decisions: ['默认使用 TypeScript'],
            completedWork: ['已保存 TypeScript 偏好'],
            pendingWork: [],
            knownIssues: [],
          }),
        }
      }
      return { content: 'Main answer' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const separated = new MemoryService({ store, reviewEveryUserMessages: 1 })
    const runtime = new AgentRuntime({ modelClient: client, memory: separated })

    await runtime.run({
      messages: ['请记住以后代码示例优先使用 TypeScript'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', profileId: 'default' },
    })
    await separated.drain()

    const reviewRequest = create.mock.calls
      .map(call => call[0] as ModelRequest)
      .find(request => request.metadata?.purpose === 'ekko-memory-review')!
    const summaryRequest = create.mock.calls
      .map(call => call[0] as ModelRequest)
      .find(request => request.metadata?.purpose === 'ekko-memory-summary')!
    expect(reviewRequest.metadata).toEqual({ purpose: 'ekko-memory-review' })
    expect(reviewRequest.tools?.map(tool => tool.name)).toEqual([
      'memory_search',
      'memory_get',
      'memory_propose_update',
      'memory_forget',
    ])
    expect(reviewRequest.messages[0].content).toContain('isolated durable-memory reviewer')
    expect(summaryRequest.metadata).toEqual({ purpose: 'ekko-memory-summary' })
    expect(summaryRequest.tools).toBeUndefined()
    expect(summaryRequest.messages[0].content).toContain('isolated rolling Session summarizer')
    expect(summaryRequest.messages[0].content).toContain('You have no tools')
    expect(summaryRequest.messages[1].content).toContain('请记住以后代码示例优先使用 TypeScript')
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      summary: '{"recentTopic":"设置 TypeScript 代码示例偏好","currentGoal":"","pendingWork":[],"knownIssues":[]}',
      currentGoal: undefined,
      constraints: ['不使用 JavaScript 代码示例'],
      preferences: ['优先使用 TypeScript 代码示例'],
      decisions: ['默认使用 TypeScript'],
      completedWork: ['已保存 TypeScript 偏好'],
      pendingWork: [],
    })
    const memories = await service.search(
      { sessionId: 's1', profileId: 'default' },
      { domain: 'preference', key: 'preference.workflow:code_examples' },
    )
    expect([...memories.exact, ...memories.relevant]).toMatchObject([{
      key: 'preference.workflow:code_examples',
      revision: 1,
      profileId: 'default',
      valueJson: 'TypeScript',
      sourceMessageIds: [expect.any(String)],
    }])
  })

  it('deduplicates recaptured messages when unrelated messages shift their positions', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.captureMessages(identity, [
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])
    await service.captureMessages(identity, [
      { role: 'assistant', content: 'an earlier inserted message' },
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])

    await expect(store.listMessagesAfter({ sessionId: 's1', limit: 20 })).resolves.toHaveLength(3)
  })

  it('excludes tool payloads from the bounded model summary transcript', async () => {
    const client = modelClient()
    const onUsage = vi.fn()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        recentTopic: '',
        currentGoal: '',
        constraints: [],
        preferences: [],
        decisions: [],
        completedWork: [],
        pendingWork: [],
        knownIssues: [],
      }),
      model: 'summary-model',
      usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service, onUsage })

    await extractor.extract({
      sessionId: 's1',
      messages: [
        memoryMessage('user', '查一下天气', 'm1'),
        memoryMessage('tool', 'secret-tool-payload-with-a-long-weather-table', 'm2'),
        memoryMessage('assistant', '天气已经查好。', 'm3'),
      ],
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[1].content).toContain('查一下天气')
    expect(request.messages[1].content).toContain('天气已经查好。')
    expect(request.messages[1].content).not.toContain('secret-tool-payload')
    expect(onUsage).toHaveBeenCalledWith({
      purpose: 'ekko-memory-summary',
      usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
      model: 'summary-model',
      callIndex: 1,
    })
  })

  it('retries transient summary model failures before falling back', async () => {
    const client = modelClient()
    vi.mocked(client.create)
      .mockRejectedValueOnce(new Error('temporary capacity error'))
      .mockResolvedValueOnce({
        content: JSON.stringify({
          recentTopic: '讨论记忆系统',
          currentGoal: '',
          constraints: [],
          preferences: [],
          decisions: [],
          completedWork: [],
          pendingWork: [],
          knownIssues: [],
        }),
      })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'retry-session',
      messages: [
        memoryMessage('user', '我们讨论一下记忆系统', 'm1'),
        memoryMessage('assistant', '好的。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      summaryPatch: '{"recentTopic":"讨论记忆系统","currentGoal":"","pendingWork":[],"knownIssues":[]}',
      currentGoal: undefined,
    })
    expect(result.fallbackReason).toBeUndefined()
  })

  it('asks the summary model to repair malformed JSON before falling back', async () => {
    const client = modelClient()
    vi.mocked(client.create)
      .mockResolvedValueOnce({ content: 'I summarized the conversation.' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          recentTopic: '讨论记忆系统',
          currentGoal: '',
          constraints: [],
          preferences: [],
          decisions: [],
          completedWork: [],
          pendingWork: [],
          knownIssues: [],
        }),
      })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'repair-session',
      messages: [
        memoryMessage('user', '我们讨论一下记忆系统', 'm1'),
        memoryMessage('assistant', '好的。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(2)
    const repairRequest = vi.mocked(client.create).mock.calls[1][0] as ModelRequest
    expect(repairRequest.tools).toBeUndefined()
    expect(repairRequest.toolChoice).toBeUndefined()
    expect(repairRequest.messages.some(message => message.content.includes('invalid JSON'))).toBe(true)
    expect(result.fallbackReason).toBeUndefined()
  })

  it('persists a compact safe summary and the failure reason after retries are exhausted', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockRejectedValue(new Error('summary provider unavailable'))
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'safe-fallback-session',
      messages: [
        memoryMessage('user', '是吗？那你觉得我要怎么做得更好', 'm1'),
        memoryMessage('assistant', '可以从产品定位和社区运营入手。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({
      summaryPatch: '{"recentTopic":"是吗？那你觉得我要怎么做得更好","currentGoal":"","pendingWork":[],"knownIssues":[]}',
      currentGoal: undefined,
      knownIssues: [],
      fallbackReason: 'summary provider unavailable',
    })
    expect(result.summaryPatch).not.toContain('Assistant:')
  })

  it('normalizes completed lookup state before persisting a rolling summary', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        recentTopic: '讨论 hermes-web-ui 项目及 GitHub 表现',
        currentGoal: '探索 hermes-web-ui 项目，了解 GitHub 数据表现',
        constraints: ['以“丫鬟”身份与“老爷”互动'],
        preferences: ['称呼用户为“老爷”，以“丫鬟”角色互动'],
        decisions: [],
        completedWork: ['GitHub 3个月达到 9K+ Stars，最新版 v0.6.29'],
        pendingWork: [],
        knownIssues: [],
      }),
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'summary-quality-session',
      messages: [
        memoryMessage('user', '你帮我看下桌面 git/hermes-web-ui 的项目', 'm1'),
        memoryMessage('assistant', '已经查看并介绍了项目。', 'm2'),
        memoryMessage('user', '分析下这个项目 GitHub 的数据', 'm3'),
        memoryMessage('assistant', '已经完成 GitHub 数据分析。', 'm4'),
        memoryMessage('user', '你也觉得很不错吗', 'm5'),
        memoryMessage('assistant', '是的，这个项目表现不错。', 'm6'),
      ],
    })

    expect(result).toMatchObject({
      summaryPatch: '{"recentTopic":"讨论 hermes-web-ui 项目及 GitHub 表现","currentGoal":"","pendingWork":[],"knownIssues":[]}',
      currentGoal: undefined,
      preferences: ['称呼用户为“老爷”，以“丫鬟”角色互动'],
      completedWork: [],
      pendingWork: [],
      knownIssues: [],
    })
    expect(result.summaryPatch).not.toContain('9K')
    expect(result.summaryPatch).not.toContain('v0.6.29')
  })

  it('drops unsupported strengthened claims from the recent topic', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        recentTopic: '用户的主力项目 hermes-web-ui',
        currentGoal: '',
        constraints: [],
        preferences: [],
        decisions: [],
        completedWork: [],
        pendingWork: [],
        knownIssues: [],
      }),
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'unsupported-claim-session',
      messages: [memoryMessage('user', '帮我看下 hermes-web-ui 项目', 'm1')],
    })

    expect(result.summaryPatch).toBe('{"recentTopic":"","currentGoal":"","pendingWork":[],"knownIssues":[]}')
  })

  it('ignores model-owned taxonomy and returns the full server-owned memory card', async () => {
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!
    const result = await tool.execute({
      operation: 'create',
      kind: 'home_location',
      node: {
        valueJson: { city: '厦门', country: '中国' },
        title: '用户常住地',
        content: '用户明确表示常住在中国厦门。',
        type: 'user_preference',
        key: 'model-invented-key',
        summary: '这些字段应被服务端规则覆盖。',
      },
      reason: '用户表明自己常住厦门。',
      explicitUserIntent: true,
    }, {
      sessionId: 's1',
      profileId: 'default',
      sourceMessageIds: ['location-message-1'],
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      action: 'created',
      node: {
        profileId: 'default',
        domain: 'profile',
        type: 'fact',
        key: 'profile.location.home',
        revision: 1,
        valueJson: { city: '厦门', country: '中国' },
        title: '用户常住地',
        content: '用户明确表示常住在中国厦门。',
        entities: ['厦门'],
        sourceMessageIds: ['location-message-1'],
      },
    })
  })

  it('updates an exact memory by id and revision and rejects stale writes', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    const original = await service.proposeUpdate({
      operation: 'create',
      kind: 'home_location',
      explicitUserIntent: true,
      reason: 'The user explicitly asked to remember their location.',
      identity,
      node: { valueJson: '厦门市', title: '用户常住地', content: '用户常住在厦门市。' },
    })
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!

    const result = await tool.execute({
      operation: 'update',
      targetId: original.nodeId,
      expectedRevision: original.node?.revision,
      node: {
        valueJson: '广西南宁',
        title: '用户常住地',
        content: '用户明确表示常住在广西南宁。',
        importance: 0.9,
      },
      reason: '用户主动更正所在地为广西南宁。',
    }, identity)

    expect(result.ok).toBe(true)
    await expect(store.getNode(original.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    await expect(store.getNode((result.data as { nodeId: string }).nodeId)).resolves.toMatchObject({
      profileId: 'default',
      type: 'fact',
      key: 'profile.location.home',
      revision: 2,
      valueJson: '广西南宁',
      content: '用户明确表示常住在广西南宁。',
      entities: ['广西南宁'],
      status: 'active',
    })
    expect(store.databaseManager.connection.prepare(
      "SELECT session_id FROM memory_audit_events WHERE event_type = 'supersede' ORDER BY row_id DESC LIMIT 1",
    ).get()).toMatchObject({ session_id: 's1' })
    await expect(service.proposeUpdate({
      operation: 'update',
      targetId: (result.data as { nodeId: string }).nodeId,
      expectedRevision: 1,
      node: { valueJson: '北京' },
      reason: 'stale write',
      identity,
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'Memory revision mismatch: expected 1, current 2. Search again before mutating.',
    })
  })

  it('keeps one interaction contract and replaces duplicate relationship statements', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await expect(service.proposeUpdate({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '不允许只写自由文本。',
      identity,
      node: { title: '称呼关系', content: '用户是爸爸，助手是女儿。' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'interaction_contract requires structured valueJson with userRole, assistantRole, or addressUserAs.',
    })
    const first = await service.proposeUpdate({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '用户设定称呼。',
      identity,
      node: {
        valueJson: { userRole: '老爷', addressUserAs: '老爷' },
        title: '用户与助手的互动关系',
        content: '用户希望被称呼为老爷。',
      },
    })
    const second = await service.proposeUpdate({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '用户更新了双方关系。',
      identity,
      node: {
        valueJson: { userRole: '爸爸', assistantRole: '女儿', addressUserAs: '爸爸' },
        title: '用户与助手的互动关系',
        content: '用户将自己设定为爸爸、助手设定为女儿，并希望被称呼为爸爸。',
      },
    })

    expect(first).toMatchObject({ action: 'created', node: { key: 'interaction.relationship', revision: 1 } })
    expect(second).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 2,
      content: '用户将自己设定为爸爸、助手设定为女儿，并希望被称呼为爸爸。',
      entities: ['爸爸', '女儿'],
    } })
    await expect(store.getNode(first.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    const active = await store.queryNodes({ profileId: 'default', key: 'interaction.relationship' })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id: second.nodeId, revision: 2 })

    const patched = await service.proposeUpdate({
      operation: 'update',
      targetId: second.nodeId,
      expectedRevision: 2,
      valuePatch: { addressUserAs: '父亲' },
      unsetValueFields: ['userRole'],
      node: {
        title: '用户与助手的互动关系',
        content: '助手的互动角色是女儿，并应称呼用户为父亲。',
      },
      reason: '用户只修改称呼并删除自身角色设定。',
      identity,
    })
    expect(patched).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 3,
      valueJson: { assistantRole: '女儿', addressUserAs: '父亲' },
      content: '助手的互动角色是女儿，并应称呼用户为父亲。',
      entities: ['女儿', '父亲'],
    } })
    expect(await store.queryNodes({ profileId: 'default', key: 'interaction.relationship' })).toHaveLength(1)

    await service.proposeUpdate({
      operation: 'create',
      kind: 'home_location',
      explicitUserIntent: true,
      reason: '用户明确说明常住地。',
      identity,
      node: { valueJson: '贵阳', title: '用户常住地', content: '用户常住在贵阳。' },
    })
    const locationSearch = await service.search(identity, {
      queryText: 'home location city 位置 城市',
      limit: 10,
    })
    expect([...locationSearch.exact, ...locationSearch.relevant].map(node => node.key))
      .toEqual(['profile.location.home'])
  })

  it('requires confirmation for broad or hard deletion', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        kind: 'food_avoidance',
        itemKey: value,
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', profileId: 'default' },
        node: userPreference(value),
      })
    }
    await expect(service.forget({
      domain: 'preference', reason: 'clear preferences', identity: { sessionId: 's1', profileId: 'default' },
    })).resolves.toMatchObject({ requiresConfirmation: true, deletedIds: [] })
    const one = await service.search({ sessionId: 's1', profileId: 'default' }, { domain: 'preference', limit: 10 })
    const node = [...one.exact, ...one.relevant][0]
    const nodeId = node.id
    await expect(service.forget({
      id: nodeId,
      reason: 'missing revision',
      identity: { sessionId: 's1', profileId: 'default' },
    })).resolves.toMatchObject({
      deletedIds: [],
      reason: 'Mutation requires expectedRevision from memory_search, memory_get, or the injected memory card.',
    })
    await expect(service.forget({
      id: nodeId,
      expectedRevision: node.revision,
      reason: 'forget one exact preference',
      identity: { sessionId: 's1', profileId: 'default' },
    })).resolves.toMatchObject({ deletedIds: [nodeId], mode: 'soft' })
    const remaining = await service.search(
      { sessionId: 's1', profileId: 'default' },
      { domain: 'preference', limit: 10 },
    )
    const remainingNode = [...remaining.exact, ...remaining.relevant][0]
    const remainingNodeId = remainingNode.id
    await expect(service.forget({
      id: remainingNodeId,
      expectedRevision: remainingNode.revision,
      mode: 'hard',
      reason: 'erase',
      confirmed: false,
      identity: { sessionId: 's1', profileId: 'default' },
    }))
      .resolves.toMatchObject({ requiresConfirmation: true, deletedIds: [] })
  })

  it('degrades memory failures without blocking the model response', async () => {
    const failure = async () => { throw new Error('database unavailable') }
    const failingStore = {
      appendMessage: failure,
      listRecentMessages: failure,
      listMessagesAfter: failure,
      appendSummary: failure,
      getLatestSummary: failure,
      getNode: failure,
      upsertNode: failure,
      supersedeNode: failure,
      updateNodeStatus: failure,
      deleteNode: failure,
      queryNodes: failure,
      appendAuditEvent: failure,
      getSessionState: failure,
      setSessionState: failure,
      close() {},
    } as unknown as MemoryStore
    const degraded = new MemoryService({ store: failingStore })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: degraded })

    const result = await runtime.run({ messages: ['hello'], contextKey: 's1' })

    expect(result.output.content).toBe('ok')
    expect(result.memoryContext?.diagnostics).toMatchObject({ storeStatus: 'degraded', enabled: true })
    expect(result.memoryContext?.diagnostics.warnings).toContain('database unavailable')
    degraded.close()
  })
})

function modelClient(): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => ({ content: 'ok' })),
    stream: vi.fn(),
  }
}

function memoryMessage(role: MemoryMessage['role'], content: string, id: string): MemoryMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function userPreference(value: string): Partial<MemoryNode> {
  return {
    valueJson: value,
    title: `Avoid ${value}`,
    content: `Avoid ${value} in recommendations.`,
  }
}

function memoryNode(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    profileId: 'default',
    domain: 'preference',
    categoryPath: ['preference', 'food', 'avoid'],
    type: 'preference',
    key: 'preference.food.avoid:香菜',
    revision: 1,
    valueJson: '香菜',
    title: id,
    content: id,
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    tags: [],
    entities: [],
    sourceMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
