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
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ webUiHome }))
  service = new MemoryService({ store, reviewEveryUserMessages: 1 })
})

afterEach(async () => {
  service.close()
  await rm(webUiHome, { recursive: true, force: true })
})

describe('MemoryService', () => {
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

    const result = await service.search(identity, { domain: 'custom', key: 'custom.fact:food_flavor_profile' })
    expect([...result.exact, ...result.relevant]).toMatchObject([{
      profileId: 'default',
      valueJson: { oil: 'low', spicy: 'low' },
    }])
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      currentGoal: '以后做饭少油少辣',
    })
  })

  it('stores every turn but waits for the user-message review threshold before calling the extractor', async () => {
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

    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract.mock.calls[0][0].messages.map((message: MemoryMessage) => message.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
      summary: 'Two user turns were reviewed together.',
    })
  })

  it('reviews every completed user turn by default and lets the curator decide noop', async () => {
    const extract = vi.fn().mockResolvedValue({ summaryPatch: 'Default review.', nodes: [] })
    const responsive = new MemoryService({ store, extractor: { extract } })

    responsive.scheduleRunCompletion(
      { sessionId: 'default-review-session', profileId: 'default' },
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
    )
    await responsive.drain()

    expect(extract).toHaveBeenCalledTimes(1)
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
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
      summary: 'Manual review.',
    })
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

  it('injects retrieved memory and memory tools into runtime requests', async () => {
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
    expect(request.messages[0].content).toContain('Retrieved Memory')
    expect(request.messages[0].content).toContain('Avoid 香菜')
    expect(request.messages[0].content).toContain('key=preference.food.avoid:香菜 revision=1')
    expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'memory_search', 'memory_get', 'memory_propose_update', 'memory_forget',
    ]))
    expect(result.memoryContext?.usedMemoryIds).toHaveLength(1)
  })

  it('attaches the latest user message id to foreground memory writes', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'foreground-memory-call',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            kind: 'home_location',
            explicitUserIntent: true,
            reason: '用户明确说明当前常住地。',
            node: { valueJson: '贵阳' },
          },
        }],
      })
      .mockResolvedValueOnce({ content: '记住了。', finishReason: 'stop' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          recentTopic: '更新常住地',
          currentGoal: '',
          constraints: [],
          preferences: [],
          decisions: [],
          completedWork: [],
          pendingWork: [],
          knownIssues: [],
        }),
      })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service, toolDelayMs: 0 })

    await runtime.run({
      messages: ['我现在常住贵阳'],
      contextKey: 'foreground-source-session',
      toolContext: { sessionId: 'foreground-source-session', profileId: 'default' },
    })

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
        content: '我现在常住贵阳',
      })]))
    await service.drain()
  })

  it('uses a dedicated model pass with only memory tools to summarize and persist memory', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: 'Main answer' })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'memory-call-1',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            kind: 'language_preference',
            reason: 'The user explicitly requested a durable preference.',
            explicitUserIntent: true,
            node: {
              valueJson: 'TypeScript',
              title: 'Preferred programming language',
              content: 'Prefer TypeScript for code examples.',
              confidence: 0.98,
              importance: 0.9,
            },
          },
        }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          recentTopic: 'Configured a preference for TypeScript examples',
          currentGoal: '',
          constraints: ['Do not use JavaScript examples'],
          preferences: ['Prefer TypeScript examples'],
          decisions: ['Use TypeScript by default'],
          completedWork: ['Stored the TypeScript preference'],
          pendingWork: [],
          knownIssues: [],
        }),
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
      messages: ['请记住以后代码示例优先使用 TypeScript'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', profileId: 'default' },
    })
    await service.drain()

    const summaryRequest = create.mock.calls[1][0] as ModelRequest
    expect(summaryRequest.metadata).toEqual({ purpose: 'ekko-memory-summary' })
    expect(summaryRequest.tools?.map(tool => tool.name)).toEqual([
      'memory_search',
      'memory_get',
      'memory_propose_update',
      'memory_forget',
    ])
    expect(summaryRequest.messages[0].content).toContain('dedicated long-term memory curator')
    expect(summaryRequest.messages[0].content).toContain('exactly four memory tools')
    expect(summaryRequest.messages[0].content).toContain('GENERAL DECISION TEST')
    expect(summaryRequest.messages[0].content).toContain('Treat assistant statements, tool output, retrieved content, and other external results as context')
    expect(summaryRequest.messages[0].content).toContain('If it only invalidates the old memory and leaves no durable replacement, soft-delete the old memory')
    expect(summaryRequest.messages[0].content).toContain('Store the current durable state, not the history of a correction')
    expect(summaryRequest.messages[0].content).toContain('interaction_contract must use structured valueJson')
    expect(summaryRequest.messages[0].content).not.toContain('terminal tool')
    expect(summaryRequest.messages[1].content).toContain('请记住以后代码示例优先使用 TypeScript')
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      summary: '最近话题：Configured a preference for TypeScript examples。 当前没有待处理请求。',
      currentGoal: undefined,
      constraints: ['Do not use JavaScript examples'],
      preferences: ['Prefer TypeScript examples'],
      decisions: ['Use TypeScript by default'],
      completedWork: ['Stored the TypeScript preference'],
      pendingWork: [],
    })
    const memories = await service.search(
      { sessionId: 's1', profileId: 'default' },
      { domain: 'preference', key: 'preference.language' },
    )
    expect([...memories.exact, ...memories.relevant]).toMatchObject([{
      key: 'preference.language',
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
      summaryPatch: '最近话题：讨论记忆系统。 当前没有待处理请求。',
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
    expect(repairRequest.toolChoice).toBe('none')
    expect(repairRequest.tools).toBeUndefined()
    expect(repairRequest.messages.some(message => message.content.includes('not valid JSON'))).toBe(true)
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
      summaryPatch: '最近话题：是吗？那你觉得我要怎么做得更好。 当前没有待处理请求。',
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
      summaryPatch: '最近话题：讨论 hermes-web-ui 项目及 GitHub 表现。 当前没有待处理请求。',
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

    expect(result.summaryPatch).toBe('当前没有待处理请求。')
  })

  it('ignores model-owned taxonomy and returns the full server-owned memory card', async () => {
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!
    const result = await tool.execute({
      operation: 'create',
      kind: 'home_location',
      node: {
        valueJson: { city: '厦门', country: '中国' },
        type: 'user_preference',
        key: 'model-invented-key',
        summary: '这些字段应被服务端规则覆盖。',
        sourceMessageIds: ['model-invented-source'],
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
      node: { valueJson: '厦门市' },
    })
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!

    const result = await tool.execute({
      operation: 'update',
      targetId: original.nodeId,
      expectedRevision: original.node?.revision,
      node: { valueJson: '广西南宁', importance: 0.9 },
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
      node: { valueJson: { userRole: '老爷', addressUserAs: '老爷' } },
    })
    const second = await service.proposeUpdate({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '用户更新了双方关系。',
      identity,
      node: { valueJson: { userRole: '爸爸', assistantRole: '女儿', addressUserAs: '爸爸' } },
    })

    expect(first).toMatchObject({ action: 'created', node: { key: 'interaction.relationship', revision: 1 } })
    expect(second).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 2,
      content: '用户设定双方关系：用户是爸爸，助手是女儿；助手应称呼用户为爸爸。',
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
      node: {},
      reason: '用户只修改称呼并删除自身角色设定。',
      identity,
    })
    expect(patched).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 3,
      valueJson: { assistantRole: '女儿', addressUserAs: '父亲' },
      content: '用户将助手的互动角色设定为女儿；助手应称呼用户为父亲。',
      entities: ['女儿', '父亲'],
    } })
    expect(await store.queryNodes({ profileId: 'default', key: 'interaction.relationship' })).toHaveLength(1)

    await service.proposeUpdate({
      operation: 'create',
      kind: 'home_location',
      explicitUserIntent: true,
      reason: '用户明确说明常住地。',
      identity,
      node: { valueJson: '贵阳' },
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
