import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetDb = vi.hoisted(() => vi.fn())
const mockCreateSession = vi.hoisted(() => vi.fn())
const mockAddMessage = vi.hoisted(() => vi.fn())
const mockUpdateSession = vi.hoisted(() => vi.fn())
const mockListSessionSummaries = vi.hoisted(() => vi.fn())
const mockGetSessionDetailFromDbWithProfile = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: mockGetDb,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  createSession: mockCreateSession,
  addMessage: mockAddMessage,
  updateSession: mockUpdateSession,
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: mockListSessionSummaries,
  getSessionDetailFromDbWithProfile: mockGetSessionDetailFromDbWithProfile,
}))

function mockEmptyLocalDb() {
  mockGetDb.mockReturnValue({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ count: 0 })),
    })),
  })
}

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmptyLocalDb()
    mockCreateSession.mockImplementation((data) => ({
      id: data.id,
      profile: data.profile || 'default',
      source: 'api_server',
      model: data.model || '',
      title: data.title || null,
    }))
    mockGetSessionDetailFromDbWithProfile.mockResolvedValue({
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        { role: 'assistant', content: 'hi', timestamp: 2 },
      ],
      thread_session_count: 1,
    })
  })

  it('skips sync when local DB is not empty', async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ count: 1 })),
      })),
    })

    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')
    await syncAllHermesSessionsOnStartup()

    expect(mockListSessionSummaries).not.toHaveBeenCalled()
  })

  it('syncs all Hermes session sources into the local Web UI index', async () => {
    mockListSessionSummaries.mockResolvedValue([
      {
        id: 'cli-session',
        source: 'cli',
        user_id: null,
        model: 'GLM-5',
        title: 'CLI session',
        started_at: 10,
        ended_at: null,
        end_reason: null,
        message_count: 2,
        tool_call_count: 1,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0,
        last_active: 20,
        preview: 'from cli',
      },
      {
        id: 'telegram-session',
        source: 'telegram',
        user_id: '8300764555',
        model: 'GLM-5',
        title: 'Telegram session',
        started_at: 30,
        ended_at: null,
        end_reason: null,
        message_count: 3,
        tool_call_count: 0,
        input_tokens: 200,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0,
        last_active: 40,
        preview: 'from telegram',
      },
    ])

    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')
    await syncAllHermesSessionsOnStartup()

    expect(mockListSessionSummaries).toHaveBeenCalledWith(undefined, 10000, 'default')
    expect(mockCreateSession).toHaveBeenCalledTimes(2)
    expect(mockUpdateSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      source: 'cli',
      user_id: null,
      message_count: 2,
      tool_call_count: 1,
    }))
    expect(mockUpdateSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      source: 'telegram',
      user_id: '8300764555',
      message_count: 3,
      tool_call_count: 0,
    }))
  })
})
