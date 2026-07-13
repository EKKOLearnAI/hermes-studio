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

  it('stores S400 scale readings and exposes the latest body composition in overview', async () => {
    const { createHealthScaleReading, getHealthOverview, listHealthScaleReadings } = await import('../../packages/server/src/services/hermes/health-state')

    const reading = createHealthScaleReading({
      measuredAt: '2026-07-08T08:41:00+08:00',
      sourceDevice: 'Mi Body Composition Scale S400',
      sourceModel: 'yunmai.scales.ms103',
      weightKg: 85,
      bmi: 26.8,
      bodyFatPercent: 23.9,
      bodyScore: 81,
      muscleMassKg: 61.2,
      skeletalMuscleMassKg: 34.3,
      bodyWaterPercent: 55.6,
      visceralFatLevel: 10,
      basalMetabolismKcal: 1768,
      bodyAge: 24,
      leanBodyMassKg: 64.7,
    }, 'user', 'default')

    expect(reading).toMatchObject({
      kind: 'scale_reading',
      source: 'Mi Body Composition Scale S400',
      value: {
        weightKg: 85,
        bodyFatPercent: 23.9,
        sourceModel: 'yunmai.scales.ms103',
      },
      recordedAt: '2026-07-08T08:41:00+08:00',
    })

    const overview = getHealthOverview({ profile: 'default' })
    expect(overview.weightSummary.currentKg).toBe(85)
    createHealthScaleReading({
      measuredAt: '2026-07-08T08:41:00+08:00',
      sourceDevice: 'Mi Body Composition Scale S400',
      sourceModel: 'yunmai.scales.ms103',
      weightKg: 85,
      bmi: 26.8,
      bodyFatPercent: 23.9,
    }, 'user', 'default')
    const recordsAfterDuplicateSync = getHealthOverview({ profile: 'default' }).records
    expect(recordsAfterDuplicateSync.filter(record => record.kind === 'scale_reading')).toHaveLength(1)
    expect(recordsAfterDuplicateSync.filter(record => record.kind === 'weight')).toHaveLength(1)
    expect(overview.latestScaleReading).toMatchObject({
      weightKg: 85,
      bmi: 26.8,
      bodyFatPercent: 23.9,
      bodyScore: 81,
      sourceDevice: 'Mi Body Composition Scale S400',
      sourceModel: 'yunmai.scales.ms103',
    })

    createHealthScaleReading({
      measuredAt: '2026-07-09T08:00:00+08:00',
      sourceDevice: 'Mi Body Composition Scale S400',
      sourceModel: 'yunmai.scales.ms103',
      weightKg: 84.5,
      bmi: 26.7,
    }, 'user', 'default')
    const scaleSummary = listHealthScaleReadings({ profile: 'default', limit: 1 })
    expect(scaleSummary.total).toBe(2)
    expect(scaleSummary.latest).toMatchObject({ weightKg: 84.5, measuredAt: '2026-07-09T08:00:00+08:00' })
    expect(scaleSummary.readings).toHaveLength(1)
    expect(scaleSummary.readings[0]).toMatchObject({ value: { weightKg: 84.5 } })
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

  it('builds a personal body profile from measurements, posture, and skin records', async () => {
    const { getHealthOverview, getHealthStateDbPath } = await import('../../packages/server/src/services/hermes/health-state')

    getHealthOverview({ profile: 'default' })
    const db = new DatabaseSync(getHealthStateDbPath('default'))
    const now = '2026-07-08T12:00:00.000Z'
    const baselineRecordedAt = '2025-12-16T10:30:00+08:00'
    try {
      db.prepare(`
        INSERT INTO health_records (
          id, kind, title, value_json, unit, source, notes, recorded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'body-measurement-baseline',
        'body_measurement',
        'Obsidian body measurements baseline',
        JSON.stringify({
          measurements: {
            chest_cm: 102.5,
            waist_cm: 86,
            hip_cm: 102,
            left_upper_arm_relaxed_cm: 34.5,
            right_upper_arm_relaxed_cm: 34.8,
          },
          weightKg: 83.5,
          bodyFatPercent: 21.1,
        }),
        'mixed',
        'obsidian-import',
        '2025-12-16 乐刻健身房测',
        baselineRecordedAt,
        now,
        now,
        'posture-baseline',
        'posture_assessment',
        'Posture assessment baseline',
        JSON.stringify({
          issues: ['pelvic_rotation_right', 'right_scapula_downward_rotation'],
          priority: 'high',
          pain: [{ area: 'right_neck_shoulder', score: null }],
          compensationChain: ['pelvis_right_rotation', 'lumbar_right_rotation', 'thorax_right_posterior_rotation', 'neck_left_shift_right_rotation'],
        }),
        'mixed',
        'obsidian-import',
        '右侧骨盆旋前、右侧肩胛下回旋、右侧肩颈紧绷',
        baselineRecordedAt,
        now,
        now,
        'skin-routine-baseline',
        'skin_assessment',
        'Skin routine baseline',
        JSON.stringify({
          concerns: ['acne_marks', 'acne', 'blackheads', 'hydration'],
          routine: { morning: ['cleanse', 'toner', 'serum', 'moisturizer', 'sunscreen'] },
        }),
        'mixed',
        'obsidian-import',
        '淡化痘印、消灭痘痘黑头、水润有光泽',
        baselineRecordedAt,
        now,
        now,
      )

      const overview = getHealthOverview({ profile: 'default', includeRecords: false })

      expect(overview.bodyProfile.latestMeasurements).toMatchObject({
        source: 'obsidian-import',
        measurements: {
          chest_cm: 102.5,
          waist_cm: 86,
          hip_cm: 102,
          left_upper_arm_relaxed_cm: 34.5,
          right_upper_arm_relaxed_cm: 34.8,
        },
        weightKg: 83.5,
        bodyFatPercent: 21.1,
      })
      expect(overview.bodyProfile.posture).toMatchObject({
        priority: 'high',
        issues: ['pelvic_rotation_right', 'right_scapula_downward_rotation'],
      })
      expect(overview.bodyProfile.skin).toMatchObject({
        concerns: ['acne_marks', 'acne', 'blackheads', 'hydration'],
      })
      expect(overview.bodyProfile.nextDataNeeded).toContain('body_measurements_recheck')
      expect(overview.records).toEqual([])
    } finally {
      db.close()
    }
  })

  it('derives digital twin external and internal health summaries', async () => {
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
        175,
        84.2,
        75,
        'moderate',
        JSON.stringify(['fat_loss']),
        '[]',
        '[]',
        JSON.stringify({ calories: 2100, protein: 160, vitamin_c: 100, magnesium: 350, age: 30, height_cm: 175 }),
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_records (
          id, kind, title, value_json, unit, source, notes, recorded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'record-vitamin-d',
        'lab',
        'Vitamin D',
        JSON.stringify({ value: 18, marker: 'vitamin_d', referenceRange: '30-100', status: 'low' }),
        'ng/mL',
        'checkup',
        '2026 baseline',
        `${today}T09:00:00.000Z`,
        now,
        now,
        'record-waist',
        'measurement',
        'Waist',
        JSON.stringify({ value: 92 }),
        'cm',
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
        JSON.stringify({ calories: 520, protein: 35, micros: { vitamin_c: 40, magnesium: 60 } }),
        `${today}T08:00:00.000Z`,
        '',
        now,
        now,
        'food-log-2',
        null,
        'dinner',
        1,
        'serving',
        JSON.stringify({ calories: 760, protein: 55, micros: { vitamin_c: 20, magnesium: 110 } }),
        `${today}T19:00:00.000Z`,
        '',
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_body_map (
          id, region, status, notes, payload_json, recorded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'body-upper-chest',
        'upper_chest',
        'active',
        'needs activation',
        JSON.stringify({ priority: 'high', development_level: 2, activation_level: 2, posture_constraint_level: 2 }),
        now,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO health_workouts (
          id, kind, title, duration_minutes, intensity, metrics_json, notes, started_at, ended_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'workout-1',
        'strength',
        'Upper Push',
        45,
        'medium',
        '{}',
        'bench press',
        `${today}T18:00:00.000Z`,
        null,
        now,
        now,
      )
    } finally {
      db.close()
    }

    const overview = getHealthOverview({ profile: 'default' })

    expect(overview.digitalTwinSummary).toMatchObject({
      currentWeightKg: 84.2,
      targetWeightKg: 75,
      externalConcernCount: 1,
      internalMarkerCount: 1,
      micronutrientGapCount: 2,
    })
    expect(overview.externalSummary).toMatchObject({
      topRegions: [{ region: 'upper_chest', priority: 'high' }],
      recentWorkoutCount: 1,
    })
    expect(overview.internalMarkers[0]).toMatchObject({
      id: 'record-vitamin-d',
      key: 'vitamin_d',
      label: 'Vitamin D',
      value: 18,
      unit: 'ng/mL',
      status: 'low',
      source: 'checkup',
    })
    expect(overview.micronutrientSummary.items).toEqual([
      { key: 'magnesium', consumed: 170, target: 350, remaining: 180, status: 'low' },
      { key: 'vitamin_c', consumed: 60, target: 100, remaining: 40, status: 'low' },
    ])
  })
})
