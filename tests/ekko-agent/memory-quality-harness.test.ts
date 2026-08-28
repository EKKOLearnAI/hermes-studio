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
  type MemoryMessage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../../packages/ekko-agent/src'

let dataDirectory = ''
let memory: MemoryService

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'ekko-memory-quality-'))
  memory = new MemoryService({
    store: new SqliteMemoryStore(new EkkoDatabaseManager({ baseDirectory: dataDirectory })),
    reviewEveryUserMessages: 8,
  })
})

afterEach(async () => {
  memory.close()
  await rm(dataDirectory, { recursive: true, force: true })
})

describe('Ekko memory quality harness', () => {
  it('asks the curator to follow each supporting user message without classifying the conversation', async () => {
    const client = scriptedModelClient([
      summaryResponse({
        recentTopic: 'Conception du système de mémoire',
        preferences: ['偏好简洁的记忆卡片'],
      }),
    ])
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory })

    const result = await extractor.extract({
      sessionId: 'evidence-language',
      messages: [
        message('user', 'Parlons de la conception du système de mémoire.', 'm1'),
        message('user', '记忆卡片要保持简洁。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(1)
    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[0].content).toContain('Do not choose one global language')
    expect(request.messages[0].content).toContain('language used by the user-authored evidence')
    expect(request.messages[0].content).not.toContain('zh-CN')
    expect(request.messages[1].content).toContain('Parlons de la conception du système de mémoire.')
    expect(request.messages[1].content).toContain('记忆卡片要保持简洁。')
    expect(result).toMatchObject({
      summaryPatch: '{"recentTopic":"Conception du système de mémoire","currentGoal":"","pendingWork":[],"knownIssues":[]}',
      preferences: ['偏好简洁的记忆卡片'],
    })
  })

  it('stores rolling state with language-neutral schema keys and source-language values', async () => {
    const client = scriptedModelClient([
      summaryResponse({ recentTopic: 'Reviewed the memory harness' }),
    ])
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory })

    const result = await extractor.extract({
      sessionId: 'english-summary',
      messages: [message('user', 'Review the memory harness', 'm1')],
    })

    expect(JSON.parse(result.summaryPatch!)).toEqual({
      recentTopic: 'Reviewed the memory harness',
      currentGoal: '',
      pendingWork: [],
      knownIssues: [],
    })
  })

  it('keeps mixed-language memories tied to their own supporting messages', async () => {
    const client = scriptedModelClient([
      {
        content: '',
        toolCalls: [
          memoryCreateCall('chinese-card', {
            itemKey: 'code_examples',
            sourceMessageIds: ['m1'],
            reason: '请记住以后代码示例优先用 TypeScript。',
            title: '代码示例语言偏好',
            content: '以后的代码示例优先使用 TypeScript。',
          }),
          memoryCreateCall('french-card', {
            itemKey: 'response_length',
            sourceMessageIds: ['m2'],
            reason: 'Je préfère des réponses courtes.',
            title: 'Longueur des réponses',
            content: 'Privilégier des réponses courtes.',
          }),
        ],
      },
      summaryResponse({ recentTopic: '设置 TypeScript 偏好 et réponses courtes' }),
    ])
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory })

    await extractor.extract({
      sessionId: 'mixed-language-cards',
      messages: [
        message('user', '请记住以后代码示例优先用 TypeScript。', 'm1'),
        message('user', 'Je préfère des réponses courtes.', 'm2'),
      ],
    })

    await expect(memory.list({ profileId: 'default' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'preference.workflow:code_examples',
        title: '代码示例语言偏好',
        content: '以后的代码示例优先使用 TypeScript。',
        sourceMessageIds: ['m1'],
      }),
      expect.objectContaining({
        key: 'preference.workflow:response_length',
        title: 'Longueur des réponses',
        content: 'Privilégier des réponses courtes.',
        sourceMessageIds: ['m2'],
      }),
    ]))
  })

  it('shows origin and participant evidence to the curator and persists the selected host scope', async () => {
    const roomScope = { type: 'context' as const, namespace: 'test.group-chat', id: 'room-7' }
    const client = scriptedModelClient([
      {
        content: '',
        toolCalls: [{
          id: 'room-convention',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            kind: 'project_context',
            itemKey: 'dispatch_mode',
            scope: roomScope,
            reason: '用户明确说明该群聊的持续协作规则。',
            node: {
              valueJson: '串行调度',
              title: '群聊调度方式',
              content: '该群聊使用串行调度。',
            },
          },
        }],
      },
      summaryResponse({ recentTopic: '确认群聊调度规则' }),
    ])
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory })

    await extractor.extract({
      sessionId: 'room-runtime',
      profileId: 'default',
      origin: { host: 'test-host', namespace: 'group-chat', contextId: 'room-7' },
      recallScopes: [{ type: 'profile' }, roomScope, { type: 'session', id: 'room-runtime' }],
      writeScopes: [{ type: 'profile' }, roomScope, { type: 'session', id: 'room-runtime' }],
      defaultWriteScope: roomScope,
      messages: [{
        id: 'group-message-1',
        sessionId: 'room-runtime',
        role: 'user',
        content: '群主：这个群以后都用串行调度',
        metadata: { senderId: 'owner-1', senderName: '群主' },
        createdAt: new Date().toISOString(),
      }],
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[1].content).toContain('"host":"test-host"')
    expect(request.messages[1].content).toContain('"namespace":"test.group-chat"')
    expect(request.messages[1].content).toContain('metadata={"senderId":"owner-1","senderName":"群主"}')
    await expect(memory.list({ profileId: 'default' })).resolves.toMatchObject([{
      scope: roomScope,
      origin: { host: 'test-host', namespace: 'group-chat', contextId: 'room-7' },
      key: 'project.context:dispatch_mode',
      sourceMessageIds: ['group-message-1'],
    }])
  })

  it('keeps a host-declared read-only envelope out of the memory transcript', async () => {
    const client = scriptedModelClient([
      {
        content: '',
        toolCalls: [{
          id: 'polluting-write',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            kind: 'project_context',
            itemKey: 'derived_context',
            reason: 'Persist the supplied derived context.',
            node: {
              valueJson: 'Application-generated context',
              title: 'Derived application context',
              content: 'The host supplied generated context for this request.',
            },
          },
        }],
      },
      { content: '好的。' },
    ])
    const runtime = new AgentRuntime({ modelClient: client, memory })

    const result = await runtime.run({
      contextKey: 'host-read-only',
      messages: [{
        role: 'user',
        content: '<derived_context>Application-generated reference material.</derived_context>\n<current_user_turn>大家怎么看？</current_user_turn>',
      }],
      memoryInput: {
        messages: ['大家怎么看？'],
        reviewPolicy: 'explicit-only',
      },
      toolContext: { sessionId: 'host-read-only', profileId: 'default' },
    })
    await memory.drain()

    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'memory_propose_update',
        result: expect.objectContaining({
          ok: false,
          error: expect.stringContaining('Unknown tool: memory_propose_update'),
        }),
      }),
    ]))
    await expect(memory.list({ profileId: 'default' })).resolves.toEqual([])
    await expect(memory.listMessages({ sessionId: 'host-read-only', limit: 20 })).resolves.toEqual([])
  })

  it('reviews an explicit memory request using only host-selected evidence', async () => {
    const client = scriptedModelClient([
      { content: '记住了。' },
      {
        content: '',
        toolCalls: [{
          id: 'remember-address',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            kind: 'interaction_contract',
            reason: '用户明确要求记住称呼方式。',
            explicitUserIntent: true,
            node: {
              valueJson: { addressUserAs: '老爷' },
              title: '与用户的称呼约定',
              content: '以后称呼用户为老爷。',
            },
          },
        }],
      },
      summaryResponse({ recentTopic: '记住对用户的称呼方式' }),
    ])
    const runtime = new AgentRuntime({ modelClient: client, memory })

    await runtime.run({
      contextKey: 'host-explicit-memory',
      messages: [{
        role: 'user',
        content: '<derived_context>Application-generated reference material.</derived_context>\n<current_user_turn>请记住以后叫我老爷</current_user_turn>',
      }],
      memoryInput: {
        messages: ['请记住以后叫我老爷'],
        reviewPolicy: 'explicit-only',
      },
      toolContext: { sessionId: 'host-explicit-memory', profileId: 'default' },
    })
    await memory.drain()

    const summaryRequest = vi.mocked(client.create).mock.calls[1][0] as ModelRequest
    expect(summaryRequest.messages[1].content).toContain('请记住以后叫我老爷')
    expect(summaryRequest.messages[1].content).not.toContain('Application-generated reference material')
    expect(summaryRequest.messages[1].content).not.toContain('<derived_context>')
    const storedMessages = await memory.listMessages({ sessionId: 'host-explicit-memory', limit: 20 })
    expect(storedMessages.map(item => item.content)).toEqual(['请记住以后叫我老爷', '记住了。'])
    await expect(memory.search(
      { sessionId: 'host-explicit-memory', profileId: 'default' },
      { kinds: ['interaction_contract'] },
    )).resolves.toMatchObject({
      exact: [{
        title: '与用户的称呼约定',
        content: '以后称呼用户为老爷。',
      }],
    })
  })
})

function scriptedModelClient(responses: ModelResponse[]): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => responses.shift() || { content: '' }),
    stream: vi.fn(),
  }
}

function summaryResponse(overrides: Partial<Record<
  'recentTopic' | 'currentGoal' | 'constraints' | 'preferences' | 'decisions' | 'completedWork' | 'pendingWork' | 'knownIssues',
  string | string[]
>>): ModelResponse {
  return {
    content: JSON.stringify({
      recentTopic: '',
      currentGoal: '',
      constraints: [],
      preferences: [],
      decisions: [],
      completedWork: [],
      pendingWork: [],
      knownIssues: [],
      ...overrides,
    }),
  }
}

function memoryCreateCall(
  id: string,
  text: {
    itemKey: string
    sourceMessageIds: string[]
    reason: string
    title: string
    content: string
  },
): NonNullable<ModelResponse['toolCalls']>[number] {
  return {
    id,
    name: 'memory_propose_update',
    arguments: {
      operation: 'create',
      kind: 'workflow_preference',
      itemKey: text.itemKey,
      explicitUserIntent: true,
      reason: text.reason,
      node: {
        valueJson: 'TypeScript',
        title: text.title,
        content: text.content,
        sourceMessageIds: text.sourceMessageIds,
      },
    },
  }
}

function message(role: MemoryMessage['role'], content: string, id: string): MemoryMessage {
  return {
    id,
    sessionId: 'quality-harness',
    role,
    content,
    createdAt: new Date().toISOString(),
  }
}
