import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const profileDirState = vi.hoisted(() => ({ value: '' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDirState.value,
}))

function ensureSqliteAvailable() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }
}

function createSchema(db: any) {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      pricing_version TEXT,
      title TEXT,
      api_call_count INTEGER DEFAULT 0,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      reasoning_content TEXT
    );
  `)
}

function insertSession(db: any, session: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO sessions (
      id, source, user_id, model, model_config, system_prompt, parent_session_id,
      started_at, ended_at, end_reason, message_count, tool_call_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, billing_provider, billing_base_url, billing_mode,
      estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
      pricing_version, title, api_call_count
    ) VALUES (
      @id, @source, @user_id, @model, @model_config, @system_prompt, @parent_session_id,
      @started_at, @ended_at, @end_reason, @message_count, @tool_call_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @reasoning_tokens, @billing_provider, @billing_base_url, @billing_mode,
      @estimated_cost_usd, @actual_cost_usd, @cost_status, @cost_source,
      @pricing_version, @title, @api_call_count
    )
  `).run({
    user_id: null,
    model_config: null,
    system_prompt: null,
    parent_session_id: null,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    billing_base_url: null,
    billing_mode: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    cost_source: null,
    pricing_version: null,
    title: null,
    api_call_count: 0,
    ...session,
  })
}

function insertMessage(db: any, message: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, tool_call_id, tool_calls, tool_name,
      timestamp, token_count, finish_reason, reasoning, reasoning_details,
      codex_reasoning_items, reasoning_content
    ) VALUES (
      @id, @session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name,
      @timestamp, @token_count, @finish_reason, @reasoning, @reasoning_details,
      @codex_reasoning_items, @reasoning_content
    )
  `).run({
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    reasoning_content: null,
    ...message,
  })
}

describe('session DB detail', () => {
  beforeEach(() => {
    vi.resetModules()
    profileDirState.value = mkdtempSync(join(tmpdir(), 'hwui-session-detail-db-'))
  })

  afterEach(() => {
    if (profileDirState.value) rmSync(profileDirState.value, { recursive: true, force: true })
  })

  it('reconstructs compressed continuation messages for session detail', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      source: 'cli',
      model: 'gpt-5.5',
      title: 'Root title',
      started_at: 100,
      ended_at: 110,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 10,
      output_tokens: 20,
      actual_cost_usd: 0.1,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'root-cont',
      parent_session_id: 'root',
      source: 'cli',
      model: 'gpt-5.5',
      started_at: 110,
      ended_at: 120,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      actual_cost_usd: 0.2,
      cost_status: 'final',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'before compression', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'root',
      role: 'assistant',
      content: '',
      tool_calls: JSON.stringify([{ id: 'call-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' } }]),
      finish_reason: 'tool_calls',
      reasoning_content: 'thinking before tool',
      timestamp: 102,
    })
    insertMessage(db, { id: 3, session_id: 'root-cont', role: 'tool', content: '{"output":"/tmp"}', tool_call_id: 'call-1', timestamp: 111 })
    insertMessage(db, { id: 4, session_id: 'root-cont', role: 'assistant', content: 'after compression', timestamp: 112 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const detail = await mod.getSessionDetailFromDb('root')

    expect(detail?.id).toBe('root')
    expect(detail?.message_count).toBe(4)
    expect(detail?.tool_call_count).toBe(1)
    expect(detail?.ended_at).toBe(120)
    expect(detail?.cost_status).toBe('mixed')
    expect(detail?.actual_cost_usd).toBeCloseTo(0.3)
    expect(detail?.messages.map((message: any) => `${message.session_id}:${message.role}:${message.content}`)).toEqual([
      'root:user:before compression',
      'root:assistant:',
      'root-cont:tool:{"output":"/tmp"}',
      'root-cont:assistant:after compression',
    ])
    expect(detail?.messages[1].tool_calls?.[0]?.function?.name).toBe('terminal')
    expect(detail?.messages[1].reasoning).toBe('thinking before tool')
  })
})
