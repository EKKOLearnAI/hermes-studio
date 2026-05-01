/**
 * Tests for session-sync service
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listSessionSummaries: vi.fn(),
  getSessionDetailFromDbWithProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: mocks.listSessionSummaries,
  getSessionDetailFromDbWithProfile: mocks.getSessionDetailFromDbWithProfile,
}))

import { getDb } from '../../packages/server/src/db/index'
import { initAllStores } from '../../packages/server/src/db/hermes/init'
import {
  addMessages,
  createSession,
  createSessionAlias,
  getSession,
  getSessionDetail,
  listSessionIdAliases,
  resolveSessionId,
} from '../../packages/server/src/db/hermes/session-store'
import { syncAllHermesSessionsOnStartup } from '../../packages/server/src/services/hermes/session-sync'

const canonicalSummary = {
  id: 'hermes-canonical-session',
  source: 'api_server',
  user_id: null,
  model: 'gpt-5.5',
  title: 'Pinned session identity',
  started_at: 1_710_000_000,
  ended_at: null,
  end_reason: null,
  message_count: 2,
  tool_call_count: 0,
  input_tokens: 11,
  output_tokens: 22,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0.01,
  actual_cost_usd: null,
  cost_status: 'estimated',
  preview: 'first user message',
  last_active: 1_710_000_010,
}

const canonicalMessages = [
  {
    role: 'user',
    content: 'first user message',
    timestamp: 1_710_000_000,
  },
  {
    role: 'assistant',
    content: 'first assistant answer',
    timestamp: 1_710_000_001,
  },
]

function resetDb() {
  initAllStores()
  const db = getDb()
  if (!db) return
  db.exec('DELETE FROM session_id_aliases')
  db.exec('DELETE FROM messages')
  db.exec('DELETE FROM sessions')
}

function mockHermesSource(summaries: any[] = [canonicalSummary], messages: any[] = canonicalMessages) {
  mocks.listSessionSummaries.mockImplementation(async (_source: string, _limit: number, profile: string) => (
    profile === 'default' ? summaries : []
  ))
  mocks.getSessionDetailFromDbWithProfile.mockImplementation(async (id: string, profile: string) => {
    if (profile !== 'default' || !summaries.some(summary => summary.id === id)) return null
    return {
      ...canonicalSummary,
      id,
      messages,
      thread_session_count: 1,
    }
  })
}

describe('session-sync', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
    mockHermesSource()
  })

  afterEach(() => {
    resetDb()
  })

  it('imports missing Hermes sessions using canonical session ids', async () => {
    await syncAllHermesSessionsOnStartup()

    const session = getSession(canonicalSummary.id, 'default')
    expect(session).not.toBeNull()
    expect(session?.id).toBe(canonicalSummary.id)
    expect(session?.message_count).toBe(2)

    const detail = getSessionDetail(canonicalSummary.id, 'default')
    expect(detail?.messages.map(message => message.session_id)).toEqual([
      canonicalSummary.id,
      canonicalSummary.id,
    ])
    expect(listSessionIdAliases('default')).toEqual({})
  })

  it('repairs generated UUID imports to canonical Hermes ids when local DB is not empty', async () => {
    const legacyId = '220c2949-7120-42d8-b557-e6139a78a9d3'
    createSession({
      id: legacyId,
      profile: 'default',
      model: canonicalSummary.model,
      title: canonicalSummary.title,
    })
    const db = getDb()!
    db.prepare('UPDATE sessions SET started_at = ?, last_active = ? WHERE id = ?').run(
      canonicalSummary.started_at,
      canonicalSummary.last_active,
      legacyId,
    )
    addMessages(canonicalMessages.map(message => ({
      session_id: legacyId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })))

    await syncAllHermesSessionsOnStartup()

    expect(getSession(legacyId, 'default')).toBeNull()
    expect(getSession(canonicalSummary.id, 'default')?.id).toBe(canonicalSummary.id)
    expect(resolveSessionId(legacyId, 'default')).toBe(canonicalSummary.id)
    expect(listSessionIdAliases('default')).toEqual({
      [legacyId]: canonicalSummary.id,
    })

    const detailFromAlias = getSessionDetail(legacyId, 'default')
    expect(detailFromAlias?.id).toBe(canonicalSummary.id)
    expect(detailFromAlias?.messages.map(message => message.session_id)).toEqual([
      canonicalSummary.id,
      canonicalSummary.id,
    ])
  })

  it('resolves live aliases before same-id local rows can shadow canonical sessions', () => {
    const legacyId = 'legacy-shadow-id'
    createSession({ id: canonicalSummary.id, profile: 'default', model: canonicalSummary.model, title: canonicalSummary.title })
    createSession({ id: legacyId, profile: 'default', model: canonicalSummary.model, title: 'stale duplicate' })
    createSessionAlias(legacyId, canonicalSummary.id, 'default', 'test-shadow')

    expect(resolveSessionId(legacyId, 'default')).toBe(canonicalSummary.id)
    expect(getSessionDetail(legacyId, 'default')?.id).toBe(canonicalSummary.id)
  })

  it('handles empty Hermes source without crashing', async () => {
    mockHermesSource([])

    await expect(syncAllHermesSessionsOnStartup()).resolves.toBeUndefined()

    const db = getDb()!
    const countAfter = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }
    expect(countAfter.count).toBe(0)
  })
})
