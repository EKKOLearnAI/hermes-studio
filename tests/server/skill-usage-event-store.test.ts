import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDirectory = mkdtempSync(join(tmpdir(), 'studio-skill-usage-events-'))
const originalDatabaseDirectory = process.env.HERMES_WEB_UI_TEST_DB_DIR
process.env.HERMES_WEB_UI_TEST_DB_DIR = databaseDirectory

describe('Studio skill usage event store', () => {
  beforeAll(async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    initAllStores()
  })

  afterAll(async () => {
    const { closeDb } = await import('../../packages/server/src/modules/studio/infrastructure/database')
    closeDb()
    if (originalDatabaseDirectory === undefined) delete process.env.HERMES_WEB_UI_TEST_DB_DIR
    else process.env.HERMES_WEB_UI_TEST_DB_DIR = originalDatabaseDirectory
    rmSync(databaseDirectory, { recursive: true, force: true })
  })

  it('records evidence-backed Ekko, Codex, Claude, and Pi skill events in one indexed table', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { createSession, addMessages } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { getLocalSkillUsageStats } = await import('../../packages/server/src/modules/studio/repositories/skill-usage-store')

    const cases = [
      {
        sessionId: 'ekko-skill-session',
        agent: 'ekko-agent',
        toolName: 'skill_view',
        args: { name: 'research' },
        content: '{"ok":true}',
      },
      {
        sessionId: 'codex-skill-session',
        agent: 'codex',
        toolName: 'exec_command',
        args: { cmd: 'sed -n 1,200p /tmp/.agents/skills/github/SKILL.md' },
        content: 'skill contents',
      },
      {
        sessionId: 'claude-skill-session',
        agent: 'claude',
        toolName: 'Skill',
        args: { skill: 'presentations' },
        content: 'loaded',
      },
      {
        sessionId: 'pi-skill-session',
        agent: 'pi',
        toolName: 'write_file',
        args: { path: '/tmp/.agents/skills/custom/SKILL.md' },
        content: 'updated',
      },
    ]

    for (const [index, item] of cases.entries()) {
      createSession({ id: item.sessionId, profile: 'research', source: 'coding_agent', agent: item.agent })
      const callId = `skill-call-${index}`
      addMessages([
        {
          session_id: item.sessionId,
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: item.toolName, arguments: JSON.stringify(item.args) },
          }],
          timestamp: now - index,
        },
        {
          session_id: item.sessionId,
          role: 'tool',
          content: item.content,
          tool_call_id: callId,
          tool_name: item.toolName,
          timestamp: now - index,
        },
      ])
    }

    const result = getLocalSkillUsageStats(365, now, 'research')

    expect(result.stats.summary).toEqual({
      total_skill_loads: 3,
      total_skill_edits: 1,
      total_skill_actions: 4,
      distinct_skills_used: 4,
    })
    expect(result.stats.top_skills.map(row => row.skill).sort()).toEqual([
      'custom',
      'github',
      'presentations',
      'research',
    ])

    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database')
    const plan = getDb()!.prepare(`
      EXPLAIN QUERY PLAN SELECT skill, COUNT(*)
      FROM skill_usage_events
      WHERE profile = ? AND timestamp > ?
      GROUP BY skill
    `).all('research', now - 365 * 86400) as Array<{ detail?: string }>
    expect(plan.some(row => String(row.detail || '').includes('idx_skill_usage_profile_timestamp'))).toBe(true)
  })

  it('keeps synced Hermes events out of results when Hermes is unavailable', async () => {
    const now = Math.floor(Date.now() / 1000)
    const {
      getLocalSkillUsageStats,
      syncExternalSkillUsageEvents,
    } = await import('../../packages/server/src/modules/studio/repositories/skill-usage-store')

    syncExternalSkillUsageEvents('hermes', 'research', [{
      messageId: 9001,
      sessionId: 'hermes-session',
      skill: 'hermes-only',
      action: 'view',
      timestamp: now,
    }], 9001)

    const studioOnly = getLocalSkillUsageStats(365, now, 'research', false)
    const withHermes = getLocalSkillUsageStats(365, now, 'research', true)

    expect(studioOnly.stats.top_skills.some(row => row.skill === 'hermes-only')).toBe(false)
    expect(withHermes.stats.top_skills.some(row => row.skill === 'hermes-only')).toBe(true)
  })
})
