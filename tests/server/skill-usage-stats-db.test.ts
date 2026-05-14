import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const profileMock = vi.hoisted(() => ({
  getActiveProfileDir: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: profileMock.getActiveProfileDir,
  getProfileDir: vi.fn(),
}))

function createStateDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-skill-usage-'))
  const db = new DatabaseSync(join(dir, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      started_at INTEGER
    );
    CREATE INDEX idx_sessions_started ON sessions(started_at);
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
    CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
  `)
  db.close()
  return dir
}

function insertSession(dir: string, row: { id: string; source?: string; started_at: number }) {
  const db = new DatabaseSync(join(dir, 'state.db'))
  db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)')
    .run(row.id, row.source ?? 'cli', row.started_at)
  db.close()
}

function insertToolResult(dir: string, row: {
  sessionId: string
  timestamp: number
  toolName?: string | null
  toolCallId?: string | null
  content: string
}) {
  const db = new DatabaseSync(join(dir, 'state.db'))
  db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.sessionId, 'tool', row.content, row.toolCallId ?? null, row.toolName ?? null, row.timestamp)
  db.close()
}

function insertAssistantToolCalls(dir: string, sessionId: string, timestamp: number, toolCalls: unknown) {
  const db = new DatabaseSync(join(dir, 'state.db'))
  db.prepare('INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'assistant', JSON.stringify(toolCalls), timestamp)
  db.close()
}

describe('Hermes skill usage analytics DB aggregation', () => {
  let profileDir: string | null = null

  beforeEach(() => {
    vi.resetModules()
    profileMock.getActiveProfileDir.mockReset()
  })

  afterEach(() => {
    if (profileDir) rmSync(profileDir, { recursive: true, force: true })
    profileDir = null
  })

  it('counts completed skill loads and edits from compact tool result rows across CLI and API-server sessions inside the requested period', async () => {
    const now = 1_700_000_000
    profileDir = createStateDb()
    profileMock.getActiveProfileDir.mockReturnValue(profileDir)

    insertSession(profileDir, { id: 'recent-cli', source: 'cli', started_at: now - 60 })
    insertToolResult(profileDir, {
      sessionId: 'recent-cli',
      timestamp: now - 50,
      content: '[skill_view] name=hermes-agent (64,764 chars)',
    })
    insertToolResult(profileDir, {
      sessionId: 'recent-cli',
      timestamp: now - 45,
      toolName: 'skill_view',
      content: '[skill_view] name=hermes-agent (64,764 chars)',
    })
    insertToolResult(profileDir, {
      sessionId: 'recent-cli',
      timestamp: now - 40,
      toolName: 'skill_manage',
      content: JSON.stringify({ success: true, message: "Patched SKILL.md in skill 'hermes-agent' (1 replacement)." }),
    })
    insertToolResult(profileDir, {
      sessionId: 'recent-cli',
      timestamp: now - 35,
      content: '[skill_view] name=github-pr-workflow (22,106 chars)',
    })
    insertAssistantToolCalls(profileDir, 'recent-cli', now - 30, [
      { function: { name: 'skill_view', arguments: JSON.stringify({ name: 'planned-but-not-counted' }) } },
    ])
    insertToolResult(profileDir, {
      sessionId: 'recent-cli',
      timestamp: now - 25,
      toolName: 'terminal',
      content: 'noop',
    })

    insertSession(profileDir, { id: 'web-api-session', source: 'api_server', started_at: now - 30 })
    insertAssistantToolCalls(profileDir, 'web-api-session', now - 22, [
      {
        id: 'call_api_skill_view',
        call_id: 'call_api_skill_view',
        type: 'function',
        function: { name: 'skill_view', arguments: JSON.stringify({ name: 'api-server-skill' }) },
      },
    ])
    insertToolResult(profileDir, {
      sessionId: 'web-api-session',
      timestamp: now - 20,
      toolCallId: 'call_api_skill_view',
      content: JSON.stringify({ success: true, name: 'api-server-skill', description: 'API-server JSON tool result' }),
    })

    insertSession(profileDir, { id: 'old-cli', source: 'cli', started_at: now - 10 * 86400 })
    insertToolResult(profileDir, {
      sessionId: 'old-cli',
      timestamp: now - 10 * 86400,
      content: '[skill_view] name=old-skill (1 chars)',
    })

    insertSession(profileDir, { id: 'long-running-cli', source: 'cli', started_at: now - 10 * 86400 })
    insertToolResult(profileDir, {
      sessionId: 'long-running-cli',
      timestamp: now - 40,
      content: '[skill_view] name=late-session-skill (1 chars)',
    })

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now)

    expect(result).toEqual({
      period_days: 7,
      summary: {
        total_skill_loads: 5,
        total_skill_edits: 1,
        total_skill_actions: 6,
        distinct_skills_used: 4,
      },
      by_day: [
        {
          date: '2023-11-14',
          view_count: 5,
          manage_count: 1,
          total_count: 6,
          skills: [
            { skill: 'hermes-agent', view_count: 2, manage_count: 1, total_count: 3 },
            { skill: 'api-server-skill', view_count: 1, manage_count: 0, total_count: 1 },
            { skill: 'github-pr-workflow', view_count: 1, manage_count: 0, total_count: 1 },
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
          percentage: 50,
          last_used_at: now - 40,
        },
        {
          skill: 'api-server-skill',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 6 * 100,
          last_used_at: now - 20,
        },
        {
          skill: 'github-pr-workflow',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 6 * 100,
          last_used_at: now - 35,
        },
        {
          skill: 'late-session-skill',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 6 * 100,
          last_used_at: now - 40,
        },
      ],
    })
  })
})
