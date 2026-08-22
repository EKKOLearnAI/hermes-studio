import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const sessionGet = vi.fn()
  const sessionRun = vi.fn()
  const messageRows = vi.fn(() => [])
  const messageRun = vi.fn()
  const updateRun = vi.fn()
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('SELECT * FROM sessions WHERE id = ?')) return { get: sessionGet }
    if (sql.includes('SELECT role, content, timestamp FROM messages')) return { all: messageRows }
    if (sql.includes('INSERT INTO sessions')) return { run: sessionRun }
    if (sql.includes('INSERT INTO messages')) return { run: messageRun }
    if (sql.includes('UPDATE sessions')) return { run: updateRun }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const db = { prepare, exec: vi.fn() }
  return { sessionGet, sessionRun, messageRows, messageRun, updateRun, prepare, db }
})

vi.mock('../../packages/server/src/db/index', () => ({
  isSqliteAvailable: vi.fn(() => true),
  getDb: vi.fn(() => mocks.db),
}))

describe('upsertExternalCodingAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionGet.mockReturnValue(null)
    mocks.messageRows.mockReturnValue([])
  })

  it('creates an ended external coding-agent session and its messages', async () => {
    const { upsertExternalCodingAgentSession } = await import('../../packages/server/src/db/hermes/session-store')

    mocks.sessionGet
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'external_codex_1', source: 'coding_agent', agent: 'codex' })

    const result = upsertExternalCodingAgentSession({
      id: 'external_codex_1',
      profile: 'default',
      agent: 'codex',
      nativeSessionId: 'codex-native-1',
      title: 'Review the change',
      workspace: 'C:\\repo',
      startedAt: 100,
      lastActive: 120,
      messages: [
        { role: 'user', content: 'Review the change', timestamp: 110 },
        { role: 'assistant', content: 'Done', timestamp: 120 },
      ],
    })

    expect(result?.id).toBe('external_codex_1')
    expect(mocks.sessionRun).toHaveBeenCalledWith(
      'external_codex_1',
      'default',
      'codex',
      'codex',
      'global',
      'codex-native-1',
      'codex-native-1',
      'global',
      'Review the change',
      100,
      120,
      'external_import',
      120,
      'C:\\repo',
      0,
    )
    expect(mocks.messageRun).toHaveBeenCalledTimes(2)
    expect(mocks.updateRun).toHaveBeenCalled()
    expect(mocks.db.exec).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(mocks.db.exec).toHaveBeenLastCalledWith('COMMIT')
  })

  it('does not duplicate messages when an external file is synced again', async () => {
    const { upsertExternalCodingAgentSession } = await import('../../packages/server/src/db/hermes/session-store')
    mocks.sessionGet
      .mockReturnValueOnce({ id: 'external_claude_1', source: 'claude', agent: 'claude', agent_native_session_id: 'claude-native-1' })
      .mockReturnValueOnce({ id: 'external_claude_1', source: 'claude', agent: 'claude' })
    mocks.messageRows.mockReturnValue([
      { role: 'user', content: 'Hello', timestamp: 100 },
    ])

    upsertExternalCodingAgentSession({
      id: 'external_claude_1',
      profile: 'default',
      agent: 'claude',
      nativeSessionId: 'claude-native-1',
      title: 'Hello',
      workspace: 'C:\\repo',
      startedAt: 100,
      lastActive: 120,
      messages: [
        { role: 'user', content: 'Hello', timestamp: 100 },
        { role: 'assistant', content: 'World', timestamp: 120 },
      ],
    })

    expect(mocks.messageRun).toHaveBeenCalledTimes(1)
  })
})
