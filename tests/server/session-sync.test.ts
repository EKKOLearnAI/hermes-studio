/**
 * Tests for session-sync service
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetDb,
  mockGetSession,
  mockCreateSession,
  mockAddMessage,
  mockUpdateSession,
  mockListHermesSessionSummaries,
  mockGetSessionDetailFromDbWithProfile,
  mockLogger,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockGetSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockAddMessage: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockListHermesSessionSummaries: vi.fn(),
  mockGetSessionDetailFromDbWithProfile: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: mockGetDb,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: mockGetSession,
  createSession: mockCreateSession,
  addMessage: mockAddMessage,
  updateSession: mockUpdateSession,
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: mockListHermesSessionSummaries,
  getSessionDetailFromDbWithProfile: mockGetSessionDetailFromDbWithProfile,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => profile === 'default' ? '/fake/home/.hermes' : `/fake/home/.hermes/profiles/${profile}`,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: mockLogger,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => '/fake/home' }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: () => false, readdirSync: () => [] }
})

const webuiSummary = {
  id: 'webui-session-1',
  source: 'webui',
  user_id: null,
  model: 'gpt-5.5',
  title: 'Work laptop chat',
  started_at: 100,
  ended_at: null,
  end_reason: null,
  message_count: 2,
  tool_call_count: 0,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  cost_status: '',
  preview: 'hello from work laptop',
  last_active: 110,
}

const webuiDetail = {
  ...webuiSummary,
  thread_session_count: 1,
  messages: [
    {
      id: 1,
      session_id: 'webui-session-1',
      role: 'user',
      content: 'hello from work laptop',
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: 100,
      token_count: null,
      finish_reason: null,
      reasoning: null,
    },
    {
      id: 2,
      session_id: 'webui-session-1',
      role: 'assistant',
      content: 'hello from hermes',
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: 110,
      token_count: null,
      finish_reason: 'stop',
      reasoning: null,
    },
  ],
}

function makeDb(existingSessionCount: number, legacyMatch = false) {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('COUNT(*)')) return { count: existingSessionCount }
        if (sql.includes('SELECT id FROM sessions')) return legacyMatch ? { id: 'legacy-random-id' } : undefined
        return undefined
      }),
    })),
  }
}

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDb.mockReturnValue(makeDb(1))
    mockGetSession.mockReturnValue(null)
    mockCreateSession.mockImplementation((data: any) => ({
      id: data.id,
      profile: data.profile || 'default',
      source: 'api_server',
      model: data.model || '',
      title: data.title || null,
    }))
    mockListHermesSessionSummaries.mockImplementation(async (source?: string) => {
      if (source === 'webui') return [webuiSummary]
      return []
    })
    mockGetSessionDetailFromDbWithProfile.mockResolvedValue(webuiDetail)
  })

  it('imports missing webui sessions even when the local DB already has sessions', async () => {
    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')

    await syncAllHermesSessionsOnStartup()

    expect(mockListHermesSessionSummaries).toHaveBeenCalledWith('webui', 10000, 'default')
    expect(mockCreateSession).toHaveBeenCalledWith({
      id: 'webui-session-1',
      profile: 'default',
      model: 'gpt-5.5',
      title: 'Work laptop chat',
    })
    expect(mockUpdateSession).toHaveBeenCalledWith('webui-session-1', expect.objectContaining({
      source: 'webui',
      started_at: 100,
      last_active: 110,
    }))
    expect(mockAddMessage).toHaveBeenCalledTimes(2)
  })

  it('skips a Hermes session that has already been imported by id', async () => {
    mockGetSession.mockReturnValue({ id: 'webui-session-1' })
    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')

    await syncAllHermesSessionsOnStartup()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockAddMessage).not.toHaveBeenCalled()
  })

  it('skips a Hermes session that matches an older random-id import', async () => {
    mockGetDb.mockReturnValue(makeDb(1, true))
    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')

    await syncAllHermesSessionsOnStartup()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockAddMessage).not.toHaveBeenCalled()
  })

  it('does not throw when SQLite is unavailable', async () => {
    mockGetDb.mockReturnValue(null)
    const { syncAllHermesSessionsOnStartup } = await import('../../packages/server/src/services/hermes/session-sync')

    await expect(syncAllHermesSessionsOnStartup()).resolves.toBeUndefined()
  })
})
