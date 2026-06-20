import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const dbMock = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbMock.current,
}))

function createWebUiDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      profile TEXT NOT NULL DEFAULT 'default',
      source TEXT,
      started_at INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp INTEGER
    );
    CREATE INDEX idx_messages_session_id ON messages(session_id);
  `)
  return db
}

function insertSession(db: DatabaseSync, row: { id: string; profile?: string; source?: string; started_at: number }) {
  db.prepare('INSERT INTO sessions (id, profile, source, started_at) VALUES (?, ?, ?, ?)')
    .run(row.id, row.profile ?? 'default', row.source ?? 'api_server', row.started_at)
}

function insertToolResult(db: DatabaseSync, row: {
  sessionId: string
  timestamp: number
  toolName?: string | null
  toolCallId?: string | null
  content: string
}) {
  db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.sessionId, 'tool', row.content, row.toolCallId ?? null, row.toolName ?? null, row.timestamp)
}

function insertAssistantToolCalls(db: DatabaseSync, sessionId: string, timestamp: number, toolCalls: unknown) {
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, 'assistant', '', JSON.stringify(toolCalls), timestamp)
}

describe('Hermes skill usage analytics DB aggregation', () => {
  beforeEach(() => {
    vi.resetModules()
    dbMock.current = createWebUiDb()
  })

  afterEach(() => {
    dbMock.current?.close()
    dbMock.current = null
  })

  it('counts completed skill loads and edits from Web UI sessions inside the requested profile and period', async () => {
    const now = 1_700_000_000
    const db = dbMock.current!

    insertSession(db, { id: 'recent-chat', started_at: now - 60 })
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 50,
      content: '[skill_view] name=hermes-agent (64,764 chars)',
    })
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 45,
      toolName: 'skill_view',
      content: '[skill_view] name=hermes-agent (64,764 chars)',
    })
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 40,
      toolName: 'skill_manage',
      content: JSON.stringify({ success: true, message: "Patched SKILL.md in skill 'hermes-agent' (1 replacement)." }),
    })
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 35,
      content: '[skill_view] name=github-pr-workflow (22,106 chars)',
    })
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 32,
      toolName: 'skill_view',
      content: JSON.stringify({
        success: true,
        name: 'github-project-analysis',
        description: 'x'.repeat(512),
      }),
    })
    insertAssistantToolCalls(db, 'recent-chat', now - 30, [
      { function: { name: 'skill_view', arguments: JSON.stringify({ name: 'planned-but-not-counted' }) } },
    ])
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 25,
      toolName: 'terminal',
      content: 'noop',
    })

    insertSession(db, { id: 'web-api-session', started_at: now - 30 })
    insertAssistantToolCalls(db, 'web-api-session', now - 22, [
      {
        id: 'call_api_skill_view',
        call_id: 'call_api_skill_view',
        type: 'function',
        function: { name: 'skill_view', arguments: JSON.stringify({ name: 'api-server-skill' }) },
      },
    ])
    insertToolResult(db, {
      sessionId: 'web-api-session',
      timestamp: now - 20,
      toolCallId: 'call_api_skill_view',
      content: JSON.stringify({ success: true, name: 'api-server-skill', description: 'API-server JSON tool result' }),
    })

    insertSession(db, { id: 'old-chat', started_at: now - 10 * 86400 })
    insertToolResult(db, {
      sessionId: 'old-chat',
      timestamp: now - 10 * 86400,
      content: '[skill_view] name=old-skill (1 chars)',
    })

    insertSession(db, { id: 'long-running-chat', started_at: now - 10 * 86400 })
    insertToolResult(db, {
      sessionId: 'long-running-chat',
      timestamp: now - 40,
      content: '[skill_view] name=late-session-skill (1 chars)',
    })

    insertSession(db, { id: 'other-profile-chat', profile: 'tester', started_at: now - 30 })
    insertToolResult(db, {
      sessionId: 'other-profile-chat',
      timestamp: now - 20,
      content: '[skill_view] name=other-profile-skill (1 chars)',
    })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now, 'default')

    expect(result).toEqual({
      period_days: 7,
      summary: {
        total_skill_loads: 6,
        total_skill_edits: 1,
        total_skill_actions: 7,
        distinct_skills_used: 5,
      },
      by_day: [
        {
          date: '2023-11-14',
          view_count: 6,
          manage_count: 1,
          total_count: 7,
          skills: [
            { skill: 'hermes-agent', view_count: 2, manage_count: 1, total_count: 3 },
            { skill: 'api-server-skill', view_count: 1, manage_count: 0, total_count: 1 },
            { skill: 'github-pr-workflow', view_count: 1, manage_count: 0, total_count: 1 },
            { skill: 'github-project-analysis', view_count: 1, manage_count: 0, total_count: 1 },
            { skill: 'late-session-skill', view_count: 1, manage_count: 0, total_count: 1 },
          ],
        },
      ],
      top_skills: [
        {
          skill: 'hermes-agent',
          view_count: 2,
          manage_count: 1,
          total_count: 3,
          percentage: 3 / 7 * 100,
          last_used_at: now - 40,
        },
        {
          skill: 'api-server-skill',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 7 * 100,
          last_used_at: now - 20,
        },
        {
          skill: 'github-project-analysis',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 7 * 100,
          last_used_at: now - 32,
        },
        {
          skill: 'github-pr-workflow',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 7 * 100,
          last_used_at: now - 35,
        },
        {
          skill: 'late-session-skill',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 7 * 100,
          last_used_at: now - 40,
        },
      ],
    })
  })
})
