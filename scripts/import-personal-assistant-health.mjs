import { mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

export function importPersonalAssistantHealth(options) {
  const sourcePath = options?.source
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`Source Personal Assistant DB not found: ${sourcePath || ''}`)
  }
  const targetPath = options?.target || getHealthStateDbPath(options?.profile)
  mkdirSync(dirname(targetPath), { recursive: true })

  const source = new DatabaseSync(sourcePath, { open: true, readOnly: true })
  const target = new DatabaseSync(targetPath)
  try {
    target.exec('PRAGMA journal_mode = WAL')
    target.exec('PRAGMA foreign_keys = ON')
    initHealthStateDb(target)

    const result = {
      profiles: importHealthStats(source, target),
      bodyMap: importBodyMap(source, target),
      foodItems: importFoodItems(source, target),
      foodLogs: importFoodLogs(source, target),
      foodTemplates: importFoodTemplates(source, target),
      healthRecords: importHealthRecords(source, target),
      workouts: importWorkouts(source, target),
      supplements: importSupplements(source, target),
      supplementLogs: importSupplementLogs(source, target),
      dailyPlans: importDailyPlans(source, target),
      dailyCheckins: importDailyCheckins(source, target),
    }
    return result
  } finally {
    source.close()
    target.close()
  }
}

function getHealthStateDbPath(profile) {
  const base = process.env.HERMES_HOME || join(homedir(), '.hermes')
  const name = String(profile || 'default').trim() || 'default'
  return join(name === 'default' ? base : join(base, 'profiles', name), 'health_state.db')
}

function initHealthStateDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_profile (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      birth_date TEXT,
      sex TEXT,
      height_cm REAL,
      weight_kg REAL,
      weight_target_kg REAL,
      activity_level TEXT,
      goals_json TEXT NOT NULL DEFAULT '[]',
      conditions_json TEXT NOT NULL DEFAULT '[]',
      allergies_json TEXT NOT NULL DEFAULT '[]',
      nutrition_targets_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_body_map (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      value_json TEXT NOT NULL,
      unit TEXT,
      source TEXT NOT NULL,
      notes TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_workouts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      duration_minutes REAL,
      intensity TEXT,
      metrics_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_food_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      serving_json TEXT NOT NULL,
      nutrition_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_food_logs (
      id TEXT PRIMARY KEY,
      food_item_id TEXT,
      meal TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      nutrition_json TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(food_item_id) REFERENCES health_food_items(id)
    );
    CREATE TABLE IF NOT EXISTS health_food_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      items_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_supplements (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dosage TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_supplement_logs (
      id TEXT PRIMARY KEY,
      supplement_id TEXT,
      dosage TEXT NOT NULL,
      taken_at TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(supplement_id) REFERENCES health_supplements(id)
    );
    CREATE TABLE IF NOT EXISTS health_daily_plans (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      meals_json TEXT NOT NULL,
      workouts_json TEXT NOT NULL,
      supplements_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_daily_checkins (
      id TEXT PRIMARY KEY,
      checkin_date TEXT NOT NULL,
      mood TEXT,
      energy INTEGER,
      sleep_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO health_meta(key, value)
    VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(SCHEMA_VERSION))
}

function importHealthStats(source, target) {
  const rows = readRows(source, 'life_awakening_health_stats')
  const stmt = target.prepare(`
    INSERT INTO health_profile (
      id, display_name, birth_date, sex, height_cm, weight_kg, weight_target_kg,
      activity_level, goals_json, conditions_json, allergies_json, nutrition_targets_json,
      created_at, updated_at
    )
    VALUES ('profile-default', NULL, NULL, NULL, NULL, ?, ?, NULL, ?, '[]', '[]', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      weight_kg=excluded.weight_kg,
      weight_target_kg=excluded.weight_target_kg,
      goals_json=excluded.goals_json,
      nutrition_targets_json=excluded.nutrition_targets_json,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const profile = parseJson(row.profile_data, {})
    const goals = []
    if (profile.goal_mode) goals.push(String(profile.goal_mode))
    stmt.run(
      numberOrNull(row.weight),
      numberOrNull(row.weight_target),
      json(goals),
      json(nutritionTargets(parseJson(row.nutrition_config, {}))),
      text(row.created_at),
      text(row.updated_at || row.created_at),
    )
  }
  return rows.length
}

function importBodyMap(source, target) {
  const rows = readRows(source, 'life_awakening_health_stats')
  const stmt = target.prepare(`
    INSERT INTO health_body_map (id, region, status, notes, payload_json, recorded_at, created_at, updated_at)
    VALUES (?, ?, 'active', '', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json=excluded.payload_json,
      recorded_at=excluded.recorded_at,
      updated_at=excluded.updated_at
  `)
  let count = 0
  for (const row of rows) {
    const bodyMap = parseJson(row.muscle_map_data, {})
    for (const [region, payload] of Object.entries(bodyMap)) {
      const createdAt = text(row.created_at)
      const updatedAt = text(row.updated_at || row.created_at)
      stmt.run(`pa-body-map-${region}`, region, json(payload), updatedAt, createdAt, updatedAt)
      count += 1
    }
  }
  return count
}

function importHealthRecords(source, target) {
  const rows = readRows(source, 'life_health_records')
  const stmt = target.prepare(`
    INSERT INTO health_records (id, kind, title, value_json, unit, source, notes, recorded_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'personal-assistant-import', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind,
      title=excluded.title,
      value_json=excluded.value_json,
      unit=excluded.unit,
      notes=excluded.notes,
      recorded_at=excluded.recorded_at,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at || row.recorded_at)
    stmt.run(
      `pa-health-record-${row.id}`,
      text(row.category || 'metric'),
      text(row.category || 'metric'),
      json({ value: row.value, marker: normalizeMarkerKey(row.category || 'metric'), sourceTag: nullableText(row.source_tag), sourceId: nullableText(row.source_id) }),
      nullableText(row.unit),
      text(row.notes),
      text(row.recorded_at || createdAt),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importWorkouts(source, target) {
  const rows = readRows(source, 'life_health_workouts')
  const stmt = target.prepare(`
    INSERT INTO health_workouts (id, kind, title, duration_minutes, intensity, metrics_json, notes, started_at, ended_at, created_at, updated_at)
    VALUES (?, 'workout', ?, ?, ?, '{}', ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      duration_minutes=excluded.duration_minutes,
      intensity=excluded.intensity,
      notes=excluded.notes,
      started_at=excluded.started_at,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at || row.workout_at)
    stmt.run(
      `pa-health-workout-${row.id}`,
      text(row.exercise_type || 'Workout'),
      numberOrNull(row.duration),
      nullableText(row.intensity),
      text(row.notes),
      text(row.workout_at || createdAt),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importFoodItems(source, target) {
  const rows = readRows(source, 'food_items')
  const stmt = target.prepare(`
    INSERT INTO health_food_items (id, name, brand, serving_json, nutrition_json, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      brand=excluded.brand,
      serving_json=excluded.serving_json,
      nutrition_json=excluded.nutrition_json,
      tags_json=excluded.tags_json,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-food-item-${row.id}`,
      text(row.name),
      nullableText(row.brand),
      json({ amount: numberOrNull(row.default_serving_g) || 100, unit: text(row.serving_unit || 'g') }),
      json(foodItemNutrition(row)),
      json([row.category].filter(Boolean)),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importFoodLogs(source, target) {
  const rows = readRows(source, 'life_awakening_food_logs')
  const stmt = target.prepare(`
    INSERT INTO health_food_logs (id, food_item_id, meal, quantity, unit, nutrition_json, logged_at, notes, created_at, updated_at)
    VALUES (?, NULL, ?, 1, 'serving', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      meal=excluded.meal,
      nutrition_json=excluded.nutrition_json,
      logged_at=excluded.logged_at,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-food-log-${row.id}`,
      text(row.meal_type || 'uncategorized'),
      json({
        calories: numberOrZero(row.calories),
        protein: numberOrZero(row.protein),
        carbs: numberOrZero(row.carbs),
        fat: numberOrZero(row.fat),
        fiber: numberOrZero(row.fiber),
        water: numberOrZero(row.water),
        micros: parseJson(row.micros, {}),
      }),
      createdAt,
      text(row.note),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importFoodTemplates(source, target) {
  const rows = readRows(source, 'life_awakening_food_templates')
  const stmt = target.prepare(`
    INSERT INTO health_food_templates (id, name, items_json, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, '[]', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      items_json=excluded.items_json,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-food-template-${row.id}`,
      text(row.name),
      json([{ name: row.name, nutrition: foodLogNutrition(row), note: row.note || '' }]),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importSupplements(source, target) {
  const rows = readRows(source, 'life_awakening_medications')
  const stmt = target.prepare(`
    INSERT INTO health_supplements (id, name, dosage, schedule_json, notes, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      dosage=excluded.dosage,
      schedule_json=excluded.schedule_json,
      active=excluded.active,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-supplement-${row.id}`,
      text(row.name),
      text(row.dosage),
      json({ times: parseJson(row.reminder_times, []) }),
      row.is_active ? 1 : 0,
      createdAt,
      text(row.updated_at || createdAt),
    )
  }
  return rows.length
}

function importSupplementLogs(source, target) {
  const rows = readRows(source, 'life_health_supplement_logs')
  const stmt = target.prepare(`
    INSERT INTO health_supplement_logs (id, supplement_id, dosage, taken_at, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      supplement_id=excluded.supplement_id,
      dosage=excluded.dosage,
      taken_at=excluded.taken_at,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-supplement-log-${row.id}`,
      row.source_medication_id ? `pa-supplement-${row.source_medication_id}` : null,
      text(row.dosage),
      createdAt,
      text(row.note),
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function importDailyPlans(source, target) {
  const rows = readRows(source, 'life_health_daily_plans')
  const stmt = target.prepare(`
    INSERT INTO health_daily_plans (id, plan_date, targets_json, meals_json, workouts_json, supplements_json, notes, created_at, updated_at)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plan_date=excluded.plan_date,
      targets_json=excluded.targets_json,
      workouts_json=excluded.workouts_json,
      supplements_json=excluded.supplements_json,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const payload = parseJson(row.generated_payload, {})
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-health-plan-${row.id}`,
      text(row.plan_date),
      json(payload.nutrition?.targets || {}),
      json(payload.training ? [payload.training] : []),
      json(payload.supplements?.items || []),
      text(payload.training?.summary || row.day_state || ''),
      createdAt,
      text(row.updated_at || createdAt),
    )
  }
  return rows.length
}

function importDailyCheckins(source, target) {
  const rows = readRows(source, 'life_health_daily_checkins')
  const stmt = target.prepare(`
    INSERT INTO health_daily_checkins (id, checkin_date, mood, energy, sleep_json, metrics_json, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      checkin_date=excluded.checkin_date,
      mood=excluded.mood,
      energy=excluded.energy,
      metrics_json=excluded.metrics_json,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `)
  for (const row of rows) {
    const createdAt = text(row.created_at)
    stmt.run(
      `pa-health-checkin-${row.id}`,
      text(row.checkin_date),
      text(row.workout_status),
      numberOrNull(row.energy_score),
      json({
        activation_score: row.activation_score,
        pain_score: row.pain_score,
        energy_score: row.energy_score,
        payload: parseJson(row.payload, {}),
      }),
      '',
      createdAt,
      createdAt,
    )
  }
  return rows.length
}

function readRows(db, table) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!exists) return []
  return db.prepare(`SELECT * FROM ${table}`).all()
}

function foodItemNutrition(row) {
  return {
    calories: numberOrZero(row.calories_per_100g),
    protein: numberOrZero(row.protein_per_100g),
    carbs: numberOrZero(row.carbs_per_100g),
    fat: numberOrZero(row.fat_per_100g),
    fiber: numberOrZero(row.fiber_per_100g),
    micros: micronutrients(row),
  }
}

function foodLogNutrition(row) {
  return {
    calories: numberOrZero(row.calories),
    protein: numberOrZero(row.protein),
    carbs: numberOrZero(row.carbs),
    fat: numberOrZero(row.fat),
    fiber: numberOrZero(row.fiber),
    water: numberOrZero(row.water),
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function json(value) {
  return JSON.stringify(value ?? null)
}

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function nullableText(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function numberOrZero(value) {
  return numberOrNull(value) ?? 0
}

function micronutrients(row) {
  const columns = {
    sugar: 'sugar_per_100g',
    sodium: 'sodium_per_100g',
    potassium: 'potassium_per_100g',
    calcium: 'calcium_per_100g',
    magnesium: 'magnesium_per_100g',
    iron: 'iron_per_100g',
    zinc: 'zinc_per_100g',
    vitamin_a: 'vitamin_a_per_100g',
    vitamin_c: 'vitamin_c_per_100g',
    vitamin_d: 'vitamin_d_per_100g',
    vitamin_e: 'vitamin_e_per_100g',
    vitamin_b6: 'vitamin_b6_per_100g',
    vitamin_b12: 'vitamin_b12_per_100g',
    folate: 'folate_per_100g',
    cholesterol: 'cholesterol_per_100g',
    saturated_fat: 'saturated_fat_per_100g',
    trans_fat: 'trans_fat_per_100g',
  }
  const result = {}
  for (const [key, column] of Object.entries(columns)) {
    const value = numberOrNull(row[column])
    if (value !== null) result[key] = value
  }
  return result
}

function nutritionTargets(value) {
  const keys = [
    'calories',
    'protein',
    'carbs',
    'fat',
    'fiber',
    'water',
    'sugar',
    'sodium',
    'potassium',
    'calcium',
    'magnesium',
    'iron',
    'zinc',
    'vitamin_a',
    'vitamin_c',
    'vitamin_d',
    'vitamin_e',
    'vitamin_b6',
    'vitamin_b12',
    'folate',
    'cholesterol',
    'saturated_fat',
    'trans_fat',
  ]
  const result = {}
  for (const key of keys) {
    const numeric = numberOrNull(value?.[key])
    if (numeric !== null) result[key] = numeric
  }
  return result
}

function normalizeMarkerKey(value) {
  return text(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') options.source = argv[++index]
    else if (arg === '--target') options.target = argv[++index]
    else if (arg === '--profile') options.profile = argv[++index]
  }
  return options
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const result = importPersonalAssistantHealth(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result, null, 2))
}
