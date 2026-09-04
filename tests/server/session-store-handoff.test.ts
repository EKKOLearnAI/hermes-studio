import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const insertSessionRun = vi.fn()
  const insertMessageRun = vi.fn(() => ({ lastInsertRowid: 42 }))
  const updateForkPointRun = vi.fn()
  const selectSessionGet = vi.fn()
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('INSERT INTO sessions')) return { run: insertSessionRun }
    if (sql.includes('INSERT INTO messages')) return { run: insertMessageRun }
    if (sql.includes('UPDATE sessions SET fork_point_message_id')) return { run: updateForkPointRun }
    if (sql.includes('SELECT * FROM sessions WHERE id = ?')) return { get: selectSessionGet }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const exec = vi.fn()
  const db = { prepare, exec }
  return {
    insertSessionRun,
    insertMessageRun,
    updateForkPointRun,
    selectSessionGet,
    prepare,
    exec,
    db,
  }
})

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: vi.fn(() => true),
  getDb: vi.fn(() => mocks.db),
}))

describe('createHandoffSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectSessionGet.mockReturnValue({
      id: 'handoff-child',
      profile: 'default',
      source: 'cli',
      agent: 'hermes',
      agent_mode: '',
      agent_session_id: '',
      agent_native_session_id: '',
      user_id: null,
      model: '',
      provider: '',
      api_mode: '',
      title: 'handoff: Codex work',
      parent_session_id: 'codex-parent',
      fork_point_message_id: '42',
      started_at: 123,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: '',
      last_active: 123,
      workspace: '/repo',
      category_id: null,
      history_revision: 0,
    })
  })

  it('creates a child Hermes session without touching the parent row', async () => {
    const { createHandoffSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')

    const result = createHandoffSession({
      parent_session_id: 'codex-parent',
      id: 'handoff-child',
      profile: 'default',
      source: 'cli',
      agent: 'hermes',
      title: 'handoff: Codex work',
      workspace: '/repo',
      messages: [
        { role: 'user', content: 'plan it', timestamp: 100 },
        { role: 'assistant', content: 'done', reasoning_content: 'think', timestamp: 101 },
      ],
    })

    expect(result?.id).toBe('handoff-child')
    expect(mocks.exec).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(mocks.exec).toHaveBeenLastCalledWith('COMMIT')
    expect(mocks.insertSessionRun).toHaveBeenCalledWith(
      'handoff-child',
      'default',
      'cli',
      'hermes',
      '',
      '',
      '',
      '',
      '',
      '',
      'handoff: Codex work',
      'codex-parent',
      expect.any(Number),
      expect.any(Number),
      '/repo',
      null,
      2,
    )
    expect(mocks.insertMessageRun).toHaveBeenNthCalledWith(
      1,
      'handoff-child',
      'user',
      'plan it',
      null,
      null,
      100,
      null,
      null,
      null,
      null,
      null,
    )
    expect(mocks.insertMessageRun).toHaveBeenNthCalledWith(
      2,
      'handoff-child',
      'assistant',
      'done',
      null,
      null,
      101,
      null,
      null,
      null,
      null,
      'think',
    )
    expect(mocks.updateForkPointRun).toHaveBeenCalledWith('42', 'handoff-child')
  })
})
