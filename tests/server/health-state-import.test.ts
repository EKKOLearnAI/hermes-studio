import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal assistant health importer', () => {
  let tempDir = ''
  let sourcePath = ''
  let targetPath = ''

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hwui-health-import-'))
    sourcePath = join(tempDir, 'life_awakening.db')
    targetPath = join(tempDir, 'health_state.db')
    seedOldHealthDb(sourcePath)
  })

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  })

  it('imports old health data idempotently', async () => {
    const { importPersonalAssistantHealth } = await import('../../scripts/import-personal-assistant-health.mjs')

    const first = importPersonalAssistantHealth({ source: sourcePath, target: targetPath })
    const second = importPersonalAssistantHealth({ source: sourcePath, target: targetPath })

    expect(first).toMatchObject({
      foodItems: 1,
      foodLogs: 1,
      foodTemplates: 1,
      healthRecords: 1,
      workouts: 1,
      supplements: 1,
      supplementLogs: 1,
      dailyPlans: 1,
      dailyCheckins: 1,
    })
    expect(second).toMatchObject(first)

    const db = new DatabaseSync(targetPath, { open: true, readOnly: true })
    try {
      expect(count(db, 'health_food_items')).toBe(1)
      expect(count(db, 'health_food_logs')).toBe(1)
      expect(count(db, 'health_food_templates')).toBe(1)
      expect(count(db, 'health_records')).toBe(1)
      expect(count(db, 'health_workouts')).toBe(1)
      expect(count(db, 'health_supplements')).toBe(1)
      expect(count(db, 'health_supplement_logs')).toBe(1)
      expect(count(db, 'health_daily_plans')).toBe(1)
      expect(count(db, 'health_daily_checkins')).toBe(1)
      const profile = db.prepare('SELECT * FROM health_profile WHERE id = ?').get('profile-default') as any
      expect(profile.weight_kg).toBe(82.4)
      expect(profile.weight_target_kg).toBe(75)
    } finally {
      db.close()
    }
  })
})

function seedOldHealthDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE life_awakening_health_stats (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        weight REAL,
        weight_target REAL,
        body_fat REAL,
        body_fat_target REAL,
        profile_data TEXT,
        muscle_map_data TEXT,
        nutrition_config TEXT,
        supplement_config TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE life_health_records (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        category TEXT,
        value REAL,
        unit TEXT,
        notes TEXT,
        recorded_at TEXT,
        created_at TEXT
      );
      CREATE TABLE life_health_workouts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        exercise_type TEXT,
        duration INTEGER,
        intensity TEXT,
        notes TEXT,
        workout_at TEXT,
        created_at TEXT
      );
      CREATE TABLE food_items (
        id INTEGER PRIMARY KEY,
        name TEXT,
        category TEXT,
        calories_per_100g REAL,
        protein_per_100g REAL,
        carbs_per_100g REAL,
        fat_per_100g REAL,
        fiber_per_100g REAL,
        default_serving_g REAL,
        serving_unit TEXT,
        brand TEXT,
        created_at TEXT
      );
      CREATE TABLE life_awakening_food_logs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        calories INTEGER,
        protein REAL,
        carbs REAL,
        fat REAL,
        fiber REAL,
        water REAL,
        meal_type TEXT,
        micros TEXT,
        note TEXT,
        created_at TEXT
      );
      CREATE TABLE life_awakening_food_templates (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        calories INTEGER,
        protein REAL,
        carbs REAL,
        fat REAL,
        fiber REAL,
        water REAL,
        note TEXT,
        created_at TEXT
      );
      CREATE TABLE life_awakening_medications (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        dosage TEXT,
        reminder_times TEXT,
        is_active INTEGER,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE life_health_supplement_logs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        dosage TEXT,
        source_medication_id INTEGER,
        note TEXT,
        created_at TEXT
      );
      CREATE TABLE life_health_daily_plans (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        plan_date TEXT,
        day_state TEXT,
        generated_payload TEXT,
        override_payload TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE life_health_daily_checkins (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        checkin_date TEXT,
        workout_status TEXT,
        activation_score INTEGER,
        pain_score INTEGER,
        energy_score INTEGER,
        payload TEXT,
        created_at TEXT
      );
    `)
    db.prepare('INSERT INTO life_awakening_health_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      1,
      1,
      82.4,
      75,
      18,
      12,
      JSON.stringify({ training_days_per_week: 4 }),
      JSON.stringify({ shoulders: { priority: 'high' } }),
      JSON.stringify({ calories: 2200, protein: 160 }),
      JSON.stringify({ stack_name: 'basic' }),
      '2026-06-01T00:00:00Z',
      '2026-06-01T00:00:00Z',
    )
    db.prepare('INSERT INTO life_health_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, 'weight', 82.4, 'kg', 'morning', '2026-06-21T07:00:00Z', '2026-06-21T07:00:00Z')
    db.prepare('INSERT INTO life_health_workouts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, 'bench press', 45, 'medium', 'push', '2026-06-20T18:00:00Z', '2026-06-20T18:00:00Z')
    db.prepare('INSERT INTO food_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, '鸡胸肉', 'protein', 165, 31, 0, 3.6, 0, 100, 'g', '', '2026-06-01T00:00:00Z')
    db.prepare('INSERT INTO life_awakening_food_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, '鸡胸肉', 330, 62, 0, 7.2, 0, 0.5, 'lunch', '{}', 'ok', '2026-06-21T12:00:00Z')
    db.prepare('INSERT INTO life_awakening_food_templates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, '高蛋白午餐', 600, 55, 60, 15, 8, 0.5, 'template', '2026-06-01T00:00:00Z')
    db.prepare('INSERT INTO life_awakening_medications VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, '叶黄素', '1粒', JSON.stringify(['07:30']), 1, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
    db.prepare('INSERT INTO life_health_supplement_logs VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 1, '叶黄素', '1粒', 1, 'taken', '2026-06-21T07:30:00Z')
    db.prepare('INSERT INTO life_health_daily_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, '2026-06-21', 'normal_training_day', JSON.stringify({ nutrition: { targets: { calories: 2200 } }, training: { summary: 'train' }, supplements: { items: ['叶黄素'] } }), '{}', '2026-06-21T00:00:00Z', '2026-06-21T00:00:00Z')
    db.prepare('INSERT INTO life_health_daily_checkins VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, '2026-06-21', 'done', 4, 1, 4, JSON.stringify({ note: 'ok' }), '2026-06-21T22:00:00Z')
  } finally {
    db.close()
  }
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}
