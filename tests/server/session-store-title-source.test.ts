import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const sessionRow = vi.fn()
  const firstUserRow = vi.fn()
  const renameRun = vi.fn()
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('SELECT * FROM sessions WHERE id = ?')) return { get: sessionRow }
    if (sql.includes('FROM messages') && sql.includes('role = ?')) return { get: firstUserRow }
    if (sql.includes('UPDATE sessions SET title')) return { run: renameRun }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  return { sessionRow, firstUserRow, renameRun, prepare }
})

vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({
  isSqliteAvailable: vi.fn(() => true),
  getDb: vi.fn(() => ({ prepare: mocks.prepare })),
}))

import { isReplaceableLocalTitle, renameSession } from '../../packages/server/src/modules/studio/repositories/session-store'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', profile: 'default', source: 'cli', agent: 'hermes', agent_mode: '',
    agent_session_id: '', agent_native_session_id: '', user_id: null, model: '',
    provider: '', api_mode: '', reasoning_effort: '', title: null, title_source: null,
    parent_session_id: null, fork_point_message_id: null, started_at: 1, ended_at: null,
    end_reason: null, message_count: 1, tool_call_count: 0, input_tokens: 0,
    output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '',
    preview: '', last_active: 1, is_archived: 0, push_enabled: 0, workspace: null,
    category_id: null, history_revision: 0, ...overrides,
  }
}

describe('session title provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionRow.mockReturnValue(row({ title: '有什么推荐的领夹麦？' }))
    mocks.firstUserRow.mockReturnValue({ content: '有什么推荐的领夹麦？' })
  })

  it('never heals a title the user set through a rename', () => {
    mocks.sessionRow.mockReturnValue(row({ title: '我的自定义标题', title_source: 'user' }))
    expect(isReplaceableLocalTitle('s1')).toBe(false)
  })

  it('treats legacy auto titles that match the first user message as replaceable', () => {
    expect(isReplaceableLocalTitle('s1')).toBe(true)
  })

  it('treats garbage titles without provenance as replaceable', () => {
    mocks.sessionRow.mockReturnValue(row({ title: '```', title_source: 'llm' }))
    expect(isReplaceableLocalTitle('s1')).toBe(true)
  })

  it('marks renames as user-set provenance', () => {
    mocks.renameRun.mockReturnValue({ changes: 1 })
    expect(renameSession('s1', '新标题')).toBe(true)
    expect(mocks.renameRun).toHaveBeenCalledWith('新标题', 's1')
    expect(String(mocks.prepare.mock.calls.find(([sql]: any[]) => String(sql).includes('UPDATE sessions SET title'))?.[0])).toContain("title_source = 'user'")
  })
})
