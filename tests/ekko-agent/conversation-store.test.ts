import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupEkkoAgent, type EkkoAgentSetup } from '../../packages/ekko-agent/src'

let baseDirectory = ''
let setup: EkkoAgentSetup | undefined

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-conversations-'))
  setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
})

afterEach(async () => {
  setup?.close()
  setup = undefined
  await rm(baseDirectory, { recursive: true, force: true })
})

describe('EkkoConversationStore', () => {
  it('creates, lists, edits, archives, ends, and reopens sessions', () => {
    const store = setup!.conversations
    const created = store.createSession({
      id: 'session-1',
      profile: 'work',
      model: 'gpt-test',
      provider: 'openai',
      title: 'First title',
      workspace: '/tmp/workspace',
      startedAt: 100,
    })

    expect(created).toMatchObject({
      id: 'session-1',
      profile: 'work',
      title: 'First title',
      startedAt: 100,
      lastActive: 100,
      isArchived: false,
    })
    expect(store.listSessions({ profile: 'work' })).toHaveLength(1)
    expect(store.listSessions({ profile: 'default' })).toEqual([])

    expect(store.renameSession('session-1', 'Edited title')?.title).toBe('Edited title')
    expect(store.updateSession('session-1', { model: 'gpt-new', apiMode: 'responses' })).toMatchObject({
      model: 'gpt-new',
      apiMode: 'responses',
    })
    expect(store.setSessionArchived('session-1', true)?.isArchived).toBe(true)
    expect(store.listSessions({ includeArchived: false })).toEqual([])
    expect(store.listSessions({ includeArchived: true })).toHaveLength(1)
    expect(store.endSession('session-1', 'done', 150)).toMatchObject({ endedAt: 150, endReason: 'done' })
    expect(store.reopenSession('session-1')).toMatchObject({ endedAt: null, endReason: null })
  })

  it('provides message CRUD and maintains session message metadata', () => {
    const store = setup!.conversations
    store.createSession({ id: 'session-1', startedAt: 100 })
    const [user, assistant] = store.addMessages([
      { sessionId: 'session-1', role: 'user', content: 'Hello\nworld', timestamp: 110, tokenCount: 2 },
      {
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Calling a tool',
        timestamp: 120,
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
        reasoning: 'Need the file',
        reasoningDetails: { format: 'test' },
      },
    ])

    expect(user.id).toBeGreaterThan(0)
    expect(assistant.toolCalls?.[0]?.name).toBe('read_file')
    expect(assistant.reasoningDetails).toEqual({ format: 'test' })
    expect(store.getSession('session-1')).toMatchObject({
      messageCount: 2,
      toolCallCount: 1,
      preview: 'Hello world',
      lastActive: 120,
    })
    expect(store.listMessages('session-1', { roles: ['assistant'] })).toHaveLength(1)
    expect(store.getSessionDetail('session-1')?.messages).toHaveLength(2)

    expect(store.updateMessage(user.id, { content: 'Edited hello', timestamp: 130 })?.content).toBe('Edited hello')
    expect(store.getSession('session-1')).toMatchObject({
      preview: 'Edited hello',
      lastActive: 130,
      historyRevision: 1,
    })
    expect(store.deleteMessage(assistant.id)).toBe(true)
    expect(store.getSession('session-1')).toMatchObject({
      messageCount: 1,
      toolCallCount: 0,
      historyRevision: 2,
    })
    expect(store.clearMessages('session-1')).toBe(1)
    expect(store.getSession('session-1')).toMatchObject({
      messageCount: 0,
      preview: '',
      lastActive: 100,
      historyRevision: 3,
    })
  })

  it('records usage independently from message edits', () => {
    const store = setup!.conversations
    store.createSession({ id: 'session-1' })
    store.addMessage({ sessionId: 'session-1', role: 'user', content: 'hello' })

    store.recordSessionUsage('session-1', {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      reasoningTokens: 2,
      billingProvider: 'openai',
      estimatedCostUsd: 0.2,
    })
    store.recordSessionUsage('session-1', {
      inputTokens: 5,
      outputTokens: 1,
      actualCostUsd: 0.1,
    })
    store.updateMessage(store.listMessages('session-1')[0].id, { content: 'changed' })

    expect(store.getSession('session-1')).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
      cacheReadTokens: 3,
      reasoningTokens: 2,
      billingProvider: 'openai',
      estimatedCostUsd: 0.2,
      actualCostUsd: 0.1,
    })
  })

  it('searches title and message content, paginates, and deletes session messages atomically', () => {
    const store = setup!.conversations
    store.createSession({ id: 'session-a', title: 'Alpha plan', startedAt: 100 })
    store.createSession({ id: 'session-b', title: 'Beta plan', startedAt: 200 })
    store.addMessage({ sessionId: 'session-a', role: 'user', content: 'Discuss database migrations' })
    store.addMessage({ sessionId: 'session-b', role: 'user', content: 'Discuss interface design' })

    expect(store.listSessions({ search: 'database' }).map(item => item.id)).toEqual(['session-a'])
    expect(store.listSessions({ limit: 1, offset: 0 }).map(item => item.id)).toEqual(['session-b'])
    expect(store.listSessions({ limit: 1, offset: 1 }).map(item => item.id)).toEqual(['session-a'])
    expect(store.listMessages('session-a', { afterId: 0 })).toHaveLength(1)

    expect(store.deleteSession('session-a')).toBe(true)
    expect(store.getSession('session-a')).toBeNull()
    expect(store.listMessages('session-a')).toEqual([])
    expect(store.deleteSession('session-a')).toBe(false)
  })
})
