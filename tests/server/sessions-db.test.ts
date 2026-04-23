import { beforeEach, describe, expect, it, vi } from 'vitest'

const allMock = vi.fn()
const titleAllMock = vi.fn()
const contentAllMock = vi.fn()
const likeAllMock = vi.fn()
const prepareMock = vi.fn((sql: string) => {
  if (sql.includes('messages_fts MATCH')) return ({ all: contentAllMock })
  if (sql.includes('m.content LIKE ?')) return ({ all: likeAllMock })
  if (sql.includes("LOWER(COALESCE(base.title, '')) LIKE ?")) return ({ all: titleAllMock })
  return ({ all: allMock })
})
const closeMock = vi.fn()
const databaseSyncMock = vi.fn(() => ({ prepare: prepareMock, close: closeMock }))
const getActiveProfileDirMock = vi.fn(() => '/tmp/hermes-profile')

vi.doMock('node:sqlite', () => ({
  DatabaseSync: databaseSyncMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: getActiveProfileDirMock,
}))

describe('session DB summaries', () => {
  beforeEach(() => {
    vi.resetModules()
    allMock.mockReset()
    titleAllMock.mockReset()
    contentAllMock.mockReset()
    likeAllMock.mockReset()
    prepareMock.mockClear()
    closeMock.mockClear()
    databaseSyncMock.mockClear()
    getActiveProfileDirMock.mockReset()
    getActiveProfileDirMock.mockReturnValue('/tmp/hermes-profile')
  })

  it('queries sqlite for lightweight session summaries', async () => {
    allMock.mockReturnValue([
      {
        id: 's1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Named session',
        started_at: 1710000000,
        ended_at: null,
        end_reason: '',
        message_count: 3,
        tool_call_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0.01,
        actual_cost_usd: null,
        cost_status: 'estimated',
        preview: 'hello world',
        last_active: 1710000005,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.listSessionSummaries(undefined, 50)

    expect(databaseSyncMock).toHaveBeenCalledWith('/tmp/hermes-profile/state.db', { open: true, readOnly: true })
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("AND s.source != 'tool'"))
    expect(allMock).toHaveBeenCalledWith(50)
    expect(closeMock).toHaveBeenCalled()
    expect(rows).toEqual([
      {
        id: 's1',
        source: 'cli',
        user_id: null,
        model: 'openai/gpt-5.4',
        title: 'Named session',
        started_at: 1710000000,
        ended_at: null,
        end_reason: null,
        message_count: 3,
        tool_call_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0.01,
        actual_cost_usd: null,
        cost_status: 'estimated',
        preview: 'hello world',
        last_active: 1710000005,
      },
    ])
  })

  it('adds source filter and falls back last_active to started_at', async () => {
    allMock.mockReturnValue([
      {
        id: 's2',
        source: 'telegram',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710000100,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 4,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'preview text',
        last_active: null,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.listSessionSummaries('telegram', 2)

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('AND s.source = ?'))
    expect(allMock).toHaveBeenCalledWith('telegram', 2)
    expect(rows[0].last_active).toBe(1710000100)
    expect(rows[0].source).toBe('telegram')
    expect(rows[0].title).toBe('preview text')
  })

  it('searches session titles and content with deduped results', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Docker debugging',
        started_at: 1710001000,
        ended_at: null,
        end_reason: '',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title preview',
        last_active: 1710001005,
        matched_message_id: null,
        snippet: 'Docker debugging',
        rank: 0,
      },
    ])
    contentAllMock.mockReturnValue([
      {
        id: 'title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Docker debugging',
        started_at: 1710001000,
        ended_at: null,
        end_reason: '',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title preview',
        last_active: 1710001005,
        matched_message_id: 42,
        snippet: '>>>docker<<< compose up',
        rank: 0.25,
      },
      {
        id: 'content-2',
        source: 'telegram',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'content preview',
        last_active: 1710002001,
        matched_message_id: 7,
        snippet: '>>>docker<<< swarm',
        rank: 0.1,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('docker', undefined, 10)

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('messages_fts MATCH'))
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('title-1')
    expect(rows[0].matched_message_id).toBeNull()
    expect(rows[0].snippet).toBe('Docker debugging')
    expect(rows[1].id).toBe('content-2')
    expect(rows[1].matched_message_id).toBe(7)
    expect(rows[1].snippet).toContain('docker')
  })

  it('falls back to LIKE search when messages_fts is missing for numeric queries', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'numeric-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002800,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'numeric preview',
        last_active: 1710002805,
        matched_message_id: 9,
        snippet: 'ticket 12345',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('123', undefined, 10)

    expect(likeAllMock).toHaveBeenCalledWith('123', '%123%')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('numeric-1')
    expect(rows[0].snippet).toContain('123')
  })

  it('keeps the source filter when messages_fts is missing for numeric queries', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'numeric-telegram-1',
        source: 'telegram',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002850,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'telegram numeric preview',
        last_active: 1710002855,
        matched_message_id: 12,
        snippet: 'telegram 123 body',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('123', 'telegram', 10)

    expect(likeAllMock).toHaveBeenCalledWith('telegram', '123', '%123%')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('telegram')
    expect(rows[0].id).toBe('numeric-telegram-1')
  })

  it('preserves title matches when messages_fts is missing for numeric queries', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'title-123',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Issue 123',
        started_at: 1710002900,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title numeric preview',
        last_active: 1710002910,
        matched_message_id: null,
        snippet: 'Issue 123',
        rank: 0,
      },
    ])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'content-123',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002890,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'content numeric preview',
        last_active: 1710002895,
        matched_message_id: 10,
        snippet: 'content 123 body',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('123', undefined, 10)

    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('title-123')
    expect(rows[0].matched_message_id).toBeNull()
    expect(rows[1].id).toBe('content-123')
    expect(rows[1].matched_message_id).toBe(10)
  })

  it('falls back to LIKE search for CJK queries', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('fts5 tokenizer miss')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'cjk-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710003000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '中文预览',
        last_active: 1710003002,
        matched_message_id: 11,
        snippet: '这是一段记忆断裂的内容',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('记忆断裂', undefined, 10)

    expect(likeAllMock).toHaveBeenCalledWith('记忆断裂', '%记忆断裂%')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('cjk-1')
    expect(rows[0].snippet).toContain('记忆断裂')
  })

  it('does not fall back to LIKE when messages_fts is missing for non-numeric queries', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')

    await expect(mod.searchSessionSummaries('docker', undefined, 10)).rejects.toThrow(
      'Failed to search sessions: no such table: messages_fts',
    )
    expect(likeAllMock).not.toHaveBeenCalled()
  })

  it('does not swallow unrelated database failures for numeric queries', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('database malformed')
    })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')

    await expect(mod.searchSessionSummaries('123', undefined, 10)).rejects.toThrow(
      'Failed to search sessions: database malformed',
    )
    expect(likeAllMock).not.toHaveBeenCalled()
  })
})
