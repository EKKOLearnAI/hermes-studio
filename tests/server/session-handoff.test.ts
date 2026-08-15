import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const getSession = vi.fn()
  const getSessionDetail = vi.fn()
  const createHandoffSession = vi.fn()
  return { getSession, getSessionDetail, createHandoffSession }
})

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: mocks.getSession,
  getSessionDetail: mocks.getSessionDetail,
  createHandoffSession: mocks.createHandoffSession,
}))

import {
  createHermesHandoffSession,
  isHandoffSourceSession,
  normalizeHandoffMessages,
} from '../../packages/server/src/services/hermes/session-handoff'

describe('session handoff service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recognizes Codex and Claude Code sessions as handoff sources', () => {
    expect(isHandoffSourceSession({ agent: 'codex' } as any)).toBe(true)
    expect(isHandoffSourceSession({ agent: 'claude' } as any)).toBe(true)
    expect(isHandoffSourceSession({ agent: 'hermes' } as any)).toBe(false)
    expect(isHandoffSourceSession(null)).toBe(false)
  })

  it('keeps only user and assistant messages when normalizing history', () => {
    const messages = [
      { id: 1, session_id: 'src', role: 'user', content: 'hello', timestamp: 100 },
      { id: 2, session_id: 'src', role: 'assistant', content: 'hi', reasoning_content: 'think', timestamp: 101 },
      { id: 3, session_id: 'src', role: 'tool', content: 'tool output', timestamp: 102 },
      { id: 4, session_id: 'src', role: 'command', content: '/model', timestamp: 103 },
    ]

    const normalized = normalizeHandoffMessages(messages as any)

    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toMatchObject({ role: 'user', content: 'hello', timestamp: 100 })
    expect(normalized[1]).toMatchObject({
      role: 'assistant',
      content: 'hi',
      reasoning_content: 'think',
      timestamp: 101,
    })
  })

  it('rejects missing or non-coding-agent source sessions', () => {
    mocks.getSession.mockReturnValueOnce(null)
    expect(createHermesHandoffSession('missing')).toMatchObject({ ok: false, status: 404 })

    mocks.getSession.mockReturnValueOnce({ id: 'hermes-session', agent: 'hermes', ended_at: 123 } as any)
    expect(createHermesHandoffSession('hermes-session')).toMatchObject({ ok: false, status: 404 })
  })

  it('rejects a source session that is still running', () => {
    mocks.getSession.mockReturnValueOnce({
      id: 'running',
      agent: 'codex',
      ended_at: null,
      message_count: 4,
    } as any)

    expect(createHermesHandoffSession('running')).toMatchObject({ ok: false, status: 409 })
  })

  it('creates a Hermes handoff session with lineage and normalized messages', () => {
    mocks.getSession.mockReturnValueOnce({
      id: 'src-codex',
      agent: 'codex',
      ended_at: 200,
      message_count: 3,
      title: 'Build feature',
      preview: '',
      profile: 'research',
      workspace: '/repo',
      category_id: 7,
    } as any)
    mocks.getSessionDetail.mockReturnValueOnce({
      messages: [
        { id: 1, session_id: 'src-codex', role: 'user', content: 'plan it', timestamp: 100 },
        { id: 2, session_id: 'src-codex', role: 'assistant', content: 'done', timestamp: 101 },
        { id: 3, session_id: 'src-codex', role: 'tool', content: 'file changed', timestamp: 102 },
      ],
    } as any)
    mocks.createHandoffSession.mockReturnValueOnce({ id: 'handoff-1' } as any)

    const result = createHermesHandoffSession('src-codex', { profile: 'research' })

    expect(result.ok).toBe(true)
    expect(mocks.createHandoffSession).toHaveBeenCalledWith(expect.objectContaining({
      parent_session_id: 'src-codex',
      profile: 'research',
      source: 'cli',
      agent: 'hermes',
      title: 'handoff: Build feature',
      workspace: '/repo',
      category_id: 7,
      messages: [
        expect.objectContaining({ role: 'user', content: 'plan it' }),
        expect.objectContaining({ role: 'assistant', content: 'done' }),
      ],
    }))
  })
})
