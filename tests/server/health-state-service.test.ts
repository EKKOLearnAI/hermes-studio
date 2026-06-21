import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('health state service', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-state-'))
    process.env.HERMES_HOME = join(hermesHome, '.hermes')
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('resolves the default profile health database under the Hermes profile directory', async () => {
    const { getHealthStateDbPath } = await import('../../packages/server/src/services/hermes/health-state')

    expect(getHealthStateDbPath('default')).toBe(join(hermesHome, '.hermes', 'health_state.db'))
    expect(getHealthStateDbPath('default').replace(/\\/g, '/')).toMatch(/\.hermes\/health_state\.db$/)
  })

  it('initializes an empty health database and returns neutral overview defaults', async () => {
    const { getHealthOverview, getHealthStateDbPath } = await import('../../packages/server/src/services/hermes/health-state')

    const overview = getHealthOverview({ profile: 'default' })
    const dbPath = getHealthStateDbPath('default')

    expect(existsSync(dbPath)).toBe(true)
    expect(overview).toMatchObject({
      profile: 'default',
      healthProfile: {
        displayName: null,
        birthDate: null,
        sex: null,
        heightCm: null,
        weightKg: null,
        activityLevel: null,
        goals: [],
        conditions: [],
        allergies: [],
      },
      bodyMap: [],
      records: [],
      workouts: [],
      foodItems: [],
      foodLogs: [],
      foodTemplates: [],
      supplements: [],
      supplementLogs: [],
      dailyPlans: [],
      dailyCheckins: [],
    })
    expect(typeof overview.generatedAt).toBe('string')

    const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    try {
      const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      expect(tableRows.map(row => row.name).sort()).toEqual([
        'health_body_map',
        'health_daily_checkins',
        'health_daily_plans',
        'health_food_items',
        'health_food_logs',
        'health_food_templates',
        'health_meta',
        'health_profile',
        'health_records',
        'health_supplement_logs',
        'health_supplements',
        'health_workouts',
      ])
    } finally {
      db.close()
    }
  })
})
