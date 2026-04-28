import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

const profileDir = vi.hoisted(() => ({ value: '' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDir.value,
}))

function createStateDb(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      title TEXT,
      started_at REAL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER,
      tool_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      billing_provider TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      parent_session_id TEXT
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      reasoning_content TEXT
    );

    CREATE VIRTUAL TABLE messages_fts USING fts5(content);
  `)
  return db
}

function insertSession(
  db: DatabaseSync,
  row: {
    id: string
    source?: string
    parent_session_id?: string | null
    title?: string
    started_at: number
    ended_at?: number | null
    end_reason?: string | null
    message_count?: number
    model?: string
  },
) {
  db.prepare(`
    INSERT INTO sessions (
      id, source, user_id, model, title, started_at, ended_at, end_reason,
      message_count, tool_call_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider,
      estimated_cost_usd, actual_cost_usd, cost_status, parent_session_id
    ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, '', 0, NULL, '', ?)
  `).run(
    row.id,
    row.source || 'api_server',
    row.model || 'gpt-5.5',
    row.title || '',
    row.started_at,
    row.ended_at ?? null,
    row.end_reason ?? null,
    row.message_count ?? 1,
    row.parent_session_id ?? null,
  )
}

function insertMessage(
  db: DatabaseSync,
  row: {
    id: number
    session_id: string
    role?: string
    content: string
    timestamp: number
  },
) {
  db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, tool_call_id, tool_calls, tool_name,
      timestamp, token_count, finish_reason, reasoning, reasoning_details,
      codex_reasoning_items, reasoning_content
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL)
  `).run(row.id, row.session_id, row.role || 'user', row.content, row.timestamp)
  db.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)').run(row.id, row.content)
}

function seedCompressionChain(db: DatabaseSync) {
  insertSession(db, {
    id: 'root',
    source: 'api_server',
    title: 'Mermaid fix',
    started_at: 100,
    ended_at: 200,
    end_reason: 'compression',
    message_count: 2,
  })
  insertSession(db, {
    id: 'middle',
    source: 'cli',
    parent_session_id: 'root',
    title: 'Mermaid fix #2',
    started_at: 201,
    ended_at: 300,
    end_reason: 'compression',
    message_count: 3,
  })
  insertSession(db, {
    id: 'tip',
    source: 'cli',
    parent_session_id: 'middle',
    title: 'Mermaid fix #3',
    started_at: 301,
    ended_at: null,
    end_reason: null,
    message_count: 4,
  })

  insertMessage(db, { id: 1, session_id: 'root', content: 'root turn', timestamp: 101 })
  insertMessage(db, { id: 2, session_id: 'middle', content: 'middle turn', timestamp: 202 })
  insertMessage(db, { id: 3, session_id: 'tip', content: 'tip lineageunique turn', timestamp: 302 })
}

describe('session DB compression lineage', () => {
  let tempDir = ''
  let db: DatabaseSync | null = null

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'wui-session-lineage-'))
    profileDir.value = tempDir
    db = createStateDb(join(tempDir, 'state.db'))
  })

  afterEach(() => {
    db?.close()
    db = null
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('projects compressed root summaries to the latest continuation tip', async () => {
    seedCompressionChain(db!)

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.listSessionSummaries(undefined, 20)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'tip',
      title: 'Mermaid fix #3',
      message_count: 4,
      end_reason: null,
      preview: 'tip lineageunique turn',
      started_at: 100,
    })
  })

  it('returns the projected logical session when search matches continuation content', async () => {
    seedCompressionChain(db!)

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('lineageunique', undefined, 20)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'tip',
      title: 'Mermaid fix #3',
      matched_message_id: 3,
    })
    expect(rows[0].snippet).toContain('lineageunique')
  })

  it('hydrates the full compression chain when detail is requested by projected tip id', async () => {
    seedCompressionChain(db!)

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const detail = await mod.getSessionDetailFromDb('tip')

    expect(detail).toMatchObject({
      id: 'tip',
      title: 'Mermaid fix #3',
      message_count: 9,
      thread_session_count: 3,
    })
    expect(detail?.messages.map(message => message.session_id)).toEqual(['root', 'middle', 'tip'])
  })

  it('follows only the latest compression continuation child when a parent has multiple children', async () => {
    insertSession(db!, {
      id: 'root',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 1,
    })
    insertSession(db!, {
      id: 'older-child',
      parent_session_id: 'root',
      title: 'Older branch',
      started_at: 201,
      ended_at: null,
      end_reason: null,
      message_count: 1,
    })
    insertSession(db!, {
      id: 'latest-child',
      parent_session_id: 'root',
      title: 'Latest branch',
      started_at: 205,
      ended_at: null,
      end_reason: null,
      message_count: 1,
    })
    insertMessage(db!, { id: 11, session_id: 'root', content: 'root', timestamp: 101 })
    insertMessage(db!, { id: 12, session_id: 'older-child', content: 'older should not merge', timestamp: 202 })
    insertMessage(db!, { id: 13, session_id: 'latest-child', content: 'latest should merge', timestamp: 206 })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const detail = await mod.getSessionDetailFromDb('root')

    expect(detail).toMatchObject({
      id: 'root',
      title: 'Latest branch',
      message_count: 2,
      thread_session_count: 2,
    })
    expect(detail?.messages.map(message => message.session_id)).toEqual(['root', 'latest-child'])

    const olderDetail = await mod.getSessionDetailFromDb('older-child')
    expect(olderDetail).toMatchObject({
      id: 'older-child',
      title: 'Older branch',
      message_count: 2,
      thread_session_count: 2,
    })
    expect(olderDetail?.messages.map(message => message.session_id)).toEqual(['root', 'older-child'])

    const olderSearch = await mod.searchSessionSummaries('older should', undefined, 20)
    expect(olderSearch[0]).toMatchObject({
      id: 'older-child',
      title: 'Older branch',
      matched_message_id: 12,
    })
  })

  it('applies source filters before search candidate limiting', async () => {
    for (let index = 0; index < 105; index += 1) {
      insertSession(db!, {
        id: `cli-${index}`,
        source: 'cli',
        title: `needle cli ${index}`,
        started_at: 1000 + index,
        ended_at: null,
        end_reason: null,
      })
    }
    insertSession(db!, {
      id: 'telegram-match',
      source: 'telegram',
      title: 'needle telegram target',
      started_at: 10,
      ended_at: null,
      end_reason: null,
    })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const rows = await mod.searchSessionSummaries('needle', 'telegram', 1)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'telegram-match',
      source: 'telegram',
      title: 'needle telegram target',
    })
  })
})
