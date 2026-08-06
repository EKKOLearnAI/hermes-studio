import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('chat run invocation store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('keeps sequential invocations in one session isolated', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-1', sessionId: 'session-1', startedAt: 100 })
    store.createChatRunInvocation({ id: 'inv-2', sessionId: 'session-1', startedAt: 200 })

    expect(store.settleChatRunInvocation('inv-1', {
      status: 'completed', runId: 'run-1', output: 'first', reasoning: '', error: null, finishedAt: 300,
    })).toBe(true)

    expect(store.getChatRunInvocation('inv-1')).toMatchObject({ status: 'completed', output: 'first' })
    expect(store.getChatRunInvocation('inv-2')).toMatchObject({ status: 'running', output: null })
  })

  it('settles terminal state only once across event and reconciliation races', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-race', sessionId: 'session-1', startedAt: 100 })

    expect(store.settleChatRunInvocation('inv-race', {
      status: 'completed', runId: 'run-1', output: 'authoritative', reasoning: 'done', error: null, finishedAt: 200,
    })).toBe(true)
    expect(store.settleChatRunInvocation('inv-race', {
      status: 'failed', runId: 'run-2', output: 'partial', reasoning: '', error: 'late failure', finishedAt: 201,
    })).toBe(false)

    expect(store.getChatRunInvocation('inv-race')).toMatchObject({
      status: 'completed', run_id: 'run-1', output: 'authoritative', reasoning: 'done', error: null,
    })
  })

  it('persists requires_action and lets a later terminal outcome settle it', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-action', sessionId: 'session-1', startedAt: 100 })
    expect(store.markChatRunInvocationRequiresAction('inv-action', {
      event: 'approval.requested', approval_id: 'approval-1',
    })).toBe(true)
    expect(store.getChatRunInvocation('inv-action')).toMatchObject({
      status: 'requires_action', action: { event: 'approval.requested', approval_id: 'approval-1' },
    })
    expect(store.settleChatRunInvocation('inv-action', {
      status: 'completed', output: 'approved', finishedAt: 200,
    })).toBe(true)
    expect(store.getChatRunInvocation('inv-action')).toMatchObject({
      status: 'completed', output: 'approved', action: null,
    })
  })

  it('fails orphaned active invocations and prunes expired terminal rows', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-orphan', sessionId: 'session-1', startedAt: 100 })
    store.createChatRunInvocation({ id: 'inv-old', sessionId: 'session-2', startedAt: 100 })
    store.settleChatRunInvocation('inv-old', { status: 'completed', output: 'old', finishedAt: 200 })

    expect(store.recoverOrphanedChatRunInvocations('restart')).toBe(1)
    expect(store.getChatRunInvocation('inv-orphan')).toMatchObject({ status: 'failed', error: 'restart' })
    expect(store.pruneChatRunInvocations(201)).toBe(1)
    expect(store.getChatRunInvocation('inv-old')).toBeNull()
  })

  it('does not mark the invocation terminal when an attachment stops waiting', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-detached', sessionId: 'session-1', startedAt: 100 })

    expect(store.getChatRunInvocation('inv-detached')).toMatchObject({ status: 'running', finished_at: null })
  })

  it('bounds persisted multibyte terminal text to 2 MiB of UTF-8', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-invocation-store')
    store.createChatRunInvocation({ id: 'inv-utf8', sessionId: 'session-1', startedAt: 100 })
    const oversized = `prefix-${'你'.repeat(800_000)}`

    expect(store.settleChatRunInvocation('inv-utf8', {
      status: 'failed', output: oversized, reasoning: oversized, error: oversized, finishedAt: 200,
    })).toBe(true)
    const record = store.getChatRunInvocation('inv-utf8')!
    expect(Buffer.byteLength(record.output!, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(Buffer.byteLength(record.reasoning!, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(Buffer.byteLength(record.error!, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(record.output).not.toContain('\uFFFD')
  })
})
