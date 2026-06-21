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

  it('aggregates health overview from records, food, workouts, body map, plans, and supplements', async () => {
    const { getHealthOverview, getHealthStateDbPath } = await import('../../packages/server/src/services/hermes/health-state')

    getHealthOverview({ profile: 'default' })
    const dbPath = getHealthStateDbPath('default')
    const db = new DatabaseSync(dbPath)
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    try {
      db.prepare(`
        INSERT INTO health_profile (
          id, display_name, birth_date, sex, height_cm, weight_kg, weight_target_kg,
          activity_level, goals_json, conditions_json, allergies_json, nutrition_targets_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'profile-default',
        'Default',
        null,
        null,
        178,
        82.4,
        75,
        'moderate',
        JSON.stringify(['fat_loss']),
        '[]',
        '[]',
        JSON.stringify({ calories: 2200, protein: 160, carbs: 220, fat: 65, fiber: 30, water: 3 }),
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_records (
          id, kind, title, value_json, unit, source, notes, recorded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'weight-old',
        'weight',
        'Weight',
        JSON.stringify({ value: 83 }),
        'kg',
        'manual',
        '',
        `${today}T06:00:00.000Z`,
        now,
        now,
        'weight-new',
        'weight',
        'Weight',
        JSON.stringify({ value: 82.4 }),
        'kg',
        'manual',
        '',
        `${today}T07:00:00.000Z`,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_food_logs (
          id, food_item_id, meal, quantity, unit, nutrition_json, logged_at, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'food-log-1',
        null,
        'breakfast',
        1,
        'serving',
        JSON.stringify({ calories: 500, protein: 35, carbs: 60, fat: 15, fiber: 6, water: 0.5 }),
        `${today}T08:00:00.000Z`,
        '',
        now,
        now,
        'food-log-2',
        null,
        'lunch',
        1,
        'serving',
        JSON.stringify({ calories: 400, protein: 35, carbs: 45, fat: 12, fiber: 5, water: 0.4 }),
        `${today}T12:00:00.000Z`,
        '',
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_workouts (
          id, kind, title, duration_minutes, intensity, metrics_json, notes, started_at, ended_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'workout-old',
        'strength',
        'Pull session',
        45,
        'medium',
        '{}',
        'lat pulldown',
        `${today}T09:00:00.000Z`,
        null,
        now,
        now,
        'workout-new',
        'strength',
        'Push session',
        55,
        'high',
        '{}',
        'bench press',
        `${today}T18:00:00.000Z`,
        null,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_body_map (
          id, region, status, notes, payload_json, recorded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'body-shoulders',
        'shoulders',
        'active',
        'right shoulder compensation',
        JSON.stringify({ priority: 'high', development_level: 2, activation_level: 1, posture_constraint_level: 4 }),
        now,
        now,
        now,
        'body-glutes',
        'glutes',
        'active',
        'stable',
        JSON.stringify({ priority: 'low', development_level: 4, activation_level: 4, posture_constraint_level: 1 }),
        now,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_daily_plans (
          id, plan_date, targets_json, meals_json, workouts_json, supplements_json, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'plan-today',
        today,
        JSON.stringify({ calories: 2200 }),
        '[]',
        JSON.stringify([{ title: 'Upper body control' }]),
        '[]',
        'Prioritize shoulder stability.',
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_supplements (
          id, name, dosage, schedule_json, notes, active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'supp-1',
        '叶黄素',
        '1粒',
        JSON.stringify({ times: ['morning'] }),
        '',
        1,
        now,
        now,
        'supp-2',
        '肌酸',
        '5g',
        JSON.stringify({ times: ['evening'] }),
        '',
        1,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_supplement_logs (
          id, supplement_id, dosage, taken_at, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('supp-log-1', 'supp-1', '1粒', `${today}T07:30:00.000Z`, '', now, now)
    } finally {
      db.close()
    }

    const overview = getHealthOverview({ profile: 'default' })

    expect(overview.weightSummary).toMatchObject({
      currentKg: 82.4,
      previousKg: 83,
      deltaKg: -0.6,
      targetKg: 75,
    })
    expect(overview.nutritionSummary).toMatchObject({
      targets: { calories: 2200, protein: 160, carbs: 220, fat: 65, fiber: 30, water: 3 },
      consumed: { calories: 900, protein: 70, carbs: 105, fat: 27, fiber: 11, water: 0.9 },
      remaining: { calories: 1300, protein: 90, carbs: 115, fat: 38, fiber: 19, water: 2.1 },
    })
    expect(overview.recentWorkouts[0]).toMatchObject({ id: 'workout-new', title: 'Push session' })
    expect(overview.topBodyConcerns[0]).toMatchObject({ id: 'body-shoulders', region: 'shoulders', priority: 'high' })
    expect(overview.latestPlan).toMatchObject({ id: 'plan-today', planDate: today, notes: 'Prioritize shoulder stability.' })
    expect(overview.supplementSummary).toMatchObject({ total: 2, completedToday: 1, remainingToday: 1 })
  })
})
