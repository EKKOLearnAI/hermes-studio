import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let hermesHome = ''

function createStateDb(profileDir = hermesHome, withIndexes = true): DatabaseSync {
  mkdirSync(profileDir, { recursive: true })
  const db = new DatabaseSync(join(profileDir, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
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
  `)
  if (withIndexes) {
    db.exec(`
      CREATE INDEX idx_sessions_started ON sessions(started_at);
      CREATE INDEX idx_messages_session ON messages(session_id);
    `)
  }
  return db
}

function createProfileStateDb(profile: string): DatabaseSync {
  const profileDir = join(hermesHome, 'profiles', profile)
  return createStateDb(profileDir)
}

function insertSession(db: DatabaseSync, row: { id: string; source?: string; started_at: number }) {
  db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)')
    .run(row.id, row.source ?? 'api_server', row.started_at)
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
    hermesHome = mkdtempSync(join(tmpdir(), 'wui-skill-usage-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('counts completed skill loads and edits from canonical Hermes state.db by event timestamp', async () => {
    const now = 1_700_000_000
    const db = createStateDb()

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
    insertToolResult(db, {
      sessionId: 'recent-chat',
      timestamp: now - 10 * 86400,
      content: '[skill_view] name=old-message-inside-recent-session (1 chars)',
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
      content: JSON.stringify({ success: true, description: 'API-server JSON tool result without skill name' }),
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

    db.close()

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now, 'default')

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
          percentage: 3 / 6 * 100,
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
          skill: 'github-project-analysis',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          percentage: 1 / 6 * 100,
          last_used_at: now - 32,
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

  it('returns empty stats when the requested Hermes profile has no state.db yet', async () => {
    const now = 1_700_000_000
    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now, 'default')

    expect(result).toEqual({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('does not fall back to default usage when a named Hermes profile is missing', async () => {
    const now = 1_700_000_000
    const db = createStateDb()
    insertSession(db, { id: 'default-chat', started_at: now - 60 })
    insertToolResult(db, {
      sessionId: 'default-chat',
      timestamp: now - 50,
      content: '[skill_view] name=default-skill (1 chars)',
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now, 'deleted-profile')

    expect(result).toEqual({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('falls back when a readable Hermes state.db lacks optional performance indexes', async () => {
    const now = 1_700_000_000
    const db = createStateDb(hermesHome, false)
    insertSession(db, { id: 'indexless-chat', started_at: now - 60 })
    insertToolResult(db, {
      sessionId: 'indexless-chat',
      timestamp: now - 50,
      content: '[skill_view] name=indexless-skill (1 chars)',
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')
    const result = await mod.getSkillUsageStatsFromDb(7, now, 'default')

    expect(result.summary).toMatchObject({
      total_skill_loads: 1,
      total_skill_edits: 0,
      total_skill_actions: 1,
      distinct_skills_used: 1,
    })
    expect(result.top_skills[0]?.skill).toBe('indexless-skill')
  })

  it('uses the requested Hermes profile state.db instead of a Web UI-local profile column', async () => {
    const now = 1_700_000_000
    const defaultDb = createStateDb()
    insertSession(defaultDb, { id: 'default-chat', started_at: now - 60 })
    insertToolResult(defaultDb, {
      sessionId: 'default-chat',
      timestamp: now - 50,
      content: '[skill_view] name=default-skill (1 chars)',
    })
    defaultDb.close()

    const testerDb = createProfileStateDb('tester')
    insertSession(testerDb, { id: 'tester-chat', started_at: now - 60 })
    insertToolResult(testerDb, {
      sessionId: 'tester-chat',
      timestamp: now - 50,
      content: '[skill_view] name=tester-skill (1 chars)',
    })
    testerDb.close()

    const mod = await import('../../packages/server/src/db/hermes/sessions-db')

    const defaultResult = await mod.getSkillUsageStatsFromDb(7, now, 'default')
    expect(defaultResult.summary).toMatchObject({
      total_skill_loads: 1,
      total_skill_edits: 0,
      total_skill_actions: 1,
      distinct_skills_used: 1,
    })
    expect(defaultResult.top_skills[0]?.skill).toBe('default-skill')

    const testerResult = await mod.getSkillUsageStatsFromDb(7, now, 'tester')
    expect(testerResult.summary).toMatchObject({
      total_skill_loads: 1,
      total_skill_edits: 0,
      total_skill_actions: 1,
      distinct_skills_used: 1,
    })
    expect(testerResult.top_skills[0]?.skill).toBe('tester-skill')
  })
})
