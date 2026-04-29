import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db index module so we can test usage-store in isolation
const { mockEnsureTable, mockJsonSet, mockJsonGet, mockJsonGetAll, mockJsonDelete } = vi.hoisted(() => ({
  mockEnsureTable: vi.fn(),
  mockJsonSet: vi.fn(),
  mockJsonGet: vi.fn(),
  mockJsonGetAll: vi.fn(),
  mockJsonDelete: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  isSqliteAvailable: () => false, // Force JSON fallback path
  ensureTable: mockEnsureTable,
  getDb: () => null,
  jsonSet: mockJsonSet,
  jsonGet: mockJsonGet,
  jsonGetAll: mockJsonGetAll,
  jsonDelete: mockJsonDelete,
}))

import {
  initUsageStore,
  updateUsage,
  getUsage,
  getUsageBatch,
  deleteUsage,
} from '../../packages/server/src/db/hermes/usage-store'

describe('Usage Store (JSON fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initUsageStore calls ensureTable when SQLite is available', () => {
    // In our mock, isSqliteAvailable returns false, so ensureTable should NOT be called
    initUsageStore()
    expect(mockEnsureTable).not.toHaveBeenCalled()
  })

  it('updateUsage writes via jsonSet', () => {
    updateUsage('session-1', { inputTokens: 100, outputTokens: 50 })
    expect(mockJsonSet).toHaveBeenCalledWith(
      'session_usage',
      'session-1',
      expect.objectContaining({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: expect.any(Number),
      }),
    )
  })

  it('getUsage reads via jsonGet', () => {
    mockJsonGet.mockReturnValue({ input_tokens: 200, output_tokens: 80 })
    const result = getUsage('session-1')
    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
    expect(mockJsonGet).toHaveBeenCalledWith('session_usage', 'session-1')
  })

  it('getUsage returns undefined when jsonGet returns nothing', () => {
    mockJsonGet.mockReturnValue(undefined)
    const result = getUsage('nonexistent')
    expect(result).toBeUndefined()
  })

  it('getUsageBatch returns empty map for empty input', () => {
    const result = getUsageBatch([])
    expect(result).toEqual({})
    expect(mockJsonGetAll).not.toHaveBeenCalled()
  })

  it('getUsageBatch returns matching records', () => {
    mockJsonGetAll.mockReturnValue({
      'session-1': { input_tokens: 100, output_tokens: 50 },
      'session-2': { input_tokens: 200, output_tokens: 80 },
      'session-3': { input_tokens: 300, output_tokens: 120 },
    })
    const result = getUsageBatch(['session-1', 'session-3', 'session-missing'])
    expect(result).toEqual({
      'session-1': {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: 0,
      },
      'session-3': {
        input_tokens: 300,
        output_tokens: 120,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: 0,
      },
    })
  })

  it('deleteUsage calls jsonDelete', () => {
    deleteUsage('session-1')
    expect(mockJsonDelete).toHaveBeenCalledWith('session_usage', 'session-1')
  })
})

// Test with SQLite available (mocked)
describe('Usage Store (SQLite path)', () => {
  let runMock: ReturnType<typeof vi.fn>
  let getMock: ReturnType<typeof vi.fn>
  let allMock: ReturnType<typeof vi.fn>
  let deleteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    runMock = vi.fn()
    getMock = vi.fn()
    allMock = vi.fn()
    deleteMock = vi.fn()

    vi.doMock('../../packages/server/src/db/index', () => ({
      isSqliteAvailable: () => true,
      ensureTable: vi.fn(),
      getDb: () => ({
        prepare: vi.fn((sql: string) => {
          if (sql.includes('INSERT') || sql.includes('UPDATE')) return { run: runMock }
          if (sql.includes('SELECT') && sql.includes('WHERE session_id = ?')) return { get: getMock }
          if (sql.includes('SELECT') && sql.includes('IN')) return { all: allMock }
          if (sql.includes('DELETE')) return { run: deleteMock }
          return { run: runMock, get: getMock, all: allMock }
        }),
      }),
      jsonSet: vi.fn(),
      jsonGet: vi.fn(),
      jsonGetAll: vi.fn(),
      jsonDelete: vi.fn(),
    }))
  })

  it('updateUsage runs INSERT ... ON CONFLICT query', async () => {
    const { updateUsage } = await import('../../packages/server/src/db/hermes/usage-store')
    updateUsage('s1', { inputTokens: 500, outputTokens: 200 })
    expect(runMock).toHaveBeenCalledWith(
      's1',
      500,
      200,
      0, // cacheReadTokens
      0, // cacheWriteTokens
      0, // reasoningTokens
      '', // model
      'default', // profile
      expect.any(Number), // created_at
    )
  })

  it('getUsage queries by session_id', async () => {
    getMock.mockReturnValue({
      input_tokens: 999,
      output_tokens: 111,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
    const { getUsage } = await import('../../packages/server/src/db/hermes/usage-store')
    const result = getUsage('s1')
    expect(getMock).toHaveBeenCalledWith('s1')
    expect(result).toEqual({
      input_tokens: 999,
      output_tokens: 111,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
  })

  it('getUsageBatch queries with IN clause', async () => {
    allMock.mockReturnValue([
      { session_id: 'a', input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
      { session_id: 'b', input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
    ])
    const { getUsageBatch } = await import('../../packages/server/src/db/hermes/usage-store')
    const result = getUsageBatch(['a', 'b', 'c'])
    expect(allMock).toHaveBeenCalledWith('a', 'b', 'c')
    expect(result).toEqual({
      a: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
      b: { input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
    })
  })

  it('deleteUsage runs DELETE query', async () => {
    const { deleteUsage } = await import('../../packages/server/src/db/hermes/usage-store')
    deleteUsage('s1')
    expect(deleteMock).toHaveBeenCalledWith('s1')
  })
})
