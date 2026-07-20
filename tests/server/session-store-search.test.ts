import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session store search', () => {
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

  it('finds rendered text when Markdown markers split the stored phrase', async () => {
    const { addMessage, createSession, searchSessions } = await import(
      '../../packages/server/src/db/hermes/session-store'
    )
    createSession({ id: 'markdown-session', profile: 'default', source: 'cli', title: 'Background tasks' })
    const messageId = addMessage({
      session_id: 'markdown-session',
      role: 'assistant',
      content: '1. **单个任务** — 给一个目标，子agent独立跑完返回结果',
      timestamp: 100,
    })

    const results = searchSessions(
      undefined,
      '单个任务 — 给一个目标，子agent独立跑完返回结果',
      10,
      { sources: ['cli'], profiles: ['default'], includeArchived: false },
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(expect.objectContaining({
      id: 'markdown-session',
      matched_message_id: messageId,
      rank: 3,
    }))
  })

  it('ranks an exact coding-agent title before newer body matches and filters before limiting', async () => {
    const { addMessage, createSession, searchSessions } = await import(
      '../../packages/server/src/db/hermes/session-store'
    )
    createSession({ id: 'coding-agent', profile: 'default', source: 'coding_agent', title: 'test' })
    createSession({ id: 'recent-chat', profile: 'default', source: 'cli', title: 'Recent conversation' })
    addMessage({ session_id: 'recent-chat', role: 'assistant', content: 'A test appeared in the body', timestamp: 400 })
    createSession({ id: 'workflow', profile: 'default', source: 'workflow', title: 'test' })
    createSession({ id: 'archived-chat', profile: 'default', source: 'cli', title: 'test' })
    db.prepare('UPDATE sessions SET last_active = 100 WHERE id = ?').run('coding-agent')
    db.prepare('UPDATE sessions SET last_active = 400 WHERE id = ?').run('recent-chat')
    db.prepare('UPDATE sessions SET last_active = 500 WHERE id = ?').run('workflow')
    db.prepare('UPDATE sessions SET last_active = 600, is_archived = 1 WHERE id = ?').run('archived-chat')

    const results = searchSessions(undefined, 'test', 1, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: ['default'],
      includeArchived: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(expect.objectContaining({
      id: 'coding-agent',
      source: 'coding_agent',
      rank: 0,
    }))
  })
})
