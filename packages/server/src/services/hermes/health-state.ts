import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getProfileDir } from './hermes-profile'

const SCHEMA_VERSION = 1

export interface HealthProfile {
  displayName: string | null
  birthDate: string | null
  sex: string | null
  heightCm: number | null
  weightKg: number | null
  weightTargetKg: number | null
  activityLevel: string | null
  goals: string[]
  conditions: string[]
  allergies: string[]
  nutritionTargets: Record<string, number>
}

export interface HealthWeightSummary {
  currentKg: number | null
  previousKg: number | null
  deltaKg: number | null
  targetKg: number | null
}

export interface HealthNutritionSummary {
  targets: Record<string, number>
  consumed: Record<string, number>
  remaining: Record<string, number>
}

export interface HealthWorkoutSummary {
  id: string
  kind: string
  title: string
  durationMinutes: number | null
  intensity: string | null
  notes: string
  startedAt: string | null
}

export interface HealthBodyConcern {
  id: string
  region: string
  status: string
  priority: string | null
  developmentLevel: number | null
  activationLevel: number | null
  postureConstraintLevel: number | null
  notes: string
  score: number
}

export interface HealthDailyPlanSummary {
  id: string
  planDate: string
  targets: Record<string, unknown>
  meals: Array<Record<string, unknown>>
  workouts: Array<Record<string, unknown>>
  supplements: Array<Record<string, unknown>>
  notes: string
}

export interface HealthSupplementSummary {
  total: number
  completedToday: number
  remainingToday: number
  items: Array<{
    id: string
    name: string
    dosage: string
    active: boolean
    completedToday: boolean
  }>
}

export interface HealthOverview {
  generatedAt: string
  profile: string
  healthProfile: HealthProfile
  weightSummary: HealthWeightSummary
  nutritionSummary: HealthNutritionSummary
  recentWorkouts: HealthWorkoutSummary[]
  topBodyConcerns: HealthBodyConcern[]
  latestPlan: HealthDailyPlanSummary | null
  supplementSummary: HealthSupplementSummary
  bodyMap: Array<Record<string, unknown>>
  records: Array<Record<string, unknown>>
  workouts: Array<Record<string, unknown>>
  foodItems: Array<Record<string, unknown>>
  foodLogs: Array<Record<string, unknown>>
  foodTemplates: Array<Record<string, unknown>>
  supplements: Array<Record<string, unknown>>
  supplementLogs: Array<Record<string, unknown>>
  dailyPlans: Array<Record<string, unknown>>
  dailyCheckins: Array<Record<string, unknown>>
}

interface HealthProfileRow {
  display_name: string | null
  birth_date: string | null
  sex: string | null
  height_cm: number | null
  weight_kg: number | null
  weight_target_kg: number | null
  activity_level: string | null
  goals_json: string
  conditions_json: string
  allergies_json: string
  nutrition_targets_json: string
}

interface HealthRecordRow {
  id: string
  kind: string
  title: string
  value_json: string
  unit: string | null
  source: string
  notes: string
  recorded_at: string
  created_at: string
  updated_at: string
}

interface HealthWorkoutRow {
  id: string
  kind: string
  title: string
  duration_minutes: number | null
  intensity: string | null
  metrics_json: string
  notes: string
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

interface HealthBodyMapRow {
  id: string
  region: string
  status: string
  notes: string
  payload_json: string
  recorded_at: string
  created_at: string
  updated_at: string
}

interface HealthFoodLogRow {
  id: string
  food_item_id: string | null
  meal: string
  quantity: number
  unit: string
  nutrition_json: string
  logged_at: string
  notes: string
  created_at: string
  updated_at: string
}

interface HealthDailyPlanRow {
  id: string
  plan_date: string
  targets_json: string
  meals_json: string
  workouts_json: string
  supplements_json: string
  notes: string
  created_at: string
  updated_at: string
}

interface HealthSupplementRow {
  id: string
  name: string
  dosage: string
  schedule_json: string
  notes: string
  active: number
  created_at: string
  updated_at: string
}

interface HealthSupplementLogRow {
  id: string
  supplement_id: string | null
  dosage: string
  taken_at: string
  notes: string
  created_at: string
  updated_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function profileName(profile?: string): string {
  return profile?.trim() || 'default'
}

export function getHealthStateDbPath(profile?: string): string {
  return join(getProfileDir(profileName(profile)), 'health_state.db')
}

function openHealthStateDb(profile?: string): DatabaseSync {
  const dbPath = getHealthStateDbPath(profile)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  initHealthStateDb(db)
  return db
}

function initHealthStateDb(db: DatabaseSync): void {
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
  ensureColumns(db, 'health_profile', {
    weight_target_kg: 'REAL',
    nutrition_targets_json: "TEXT NOT NULL DEFAULT '{}'",
  })
  db.prepare(`
    INSERT INTO health_meta(key, value)
    VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(SCHEMA_VERSION))
}

function ensureColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
  Object.entries(columns).forEach(([name, definition]) => {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  })
}

export function getHealthOverview(options: { profile?: string } | string = {}): HealthOverview {
  const opts = typeof options === 'string' ? { profile: options } : options
  const profile = profileName(opts.profile)
  const db = openHealthStateDb(profile)
  try {
    const row = db.prepare('SELECT * FROM health_profile ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1').get() as HealthProfileRow | undefined
    const healthProfile = rowToHealthProfile(row)
    const records = db.prepare(`
      SELECT * FROM health_records
      ORDER BY datetime(recorded_at) DESC, id DESC
    `).all() as unknown as HealthRecordRow[]
    const workouts = db.prepare(`
      SELECT * FROM health_workouts
      ORDER BY COALESCE(datetime(started_at), datetime(created_at)) DESC, id DESC
    `).all() as unknown as HealthWorkoutRow[]
    const bodyMapRows = db.prepare(`
      SELECT * FROM health_body_map
      ORDER BY datetime(recorded_at) DESC, id DESC
    `).all() as unknown as HealthBodyMapRow[]
    const foodItems = db.prepare('SELECT * FROM health_food_items ORDER BY name ASC, id ASC').all() as Array<Record<string, unknown>>
    const foodLogs = db.prepare(`
      SELECT * FROM health_food_logs
      ORDER BY datetime(logged_at) DESC, id DESC
    `).all() as unknown as HealthFoodLogRow[]
    const foodTemplates = db.prepare('SELECT * FROM health_food_templates ORDER BY datetime(created_at) DESC, id DESC').all() as Array<Record<string, unknown>>
    const supplements = db.prepare('SELECT * FROM health_supplements ORDER BY name ASC, id ASC').all() as unknown as HealthSupplementRow[]
    const supplementLogs = db.prepare(`
      SELECT * FROM health_supplement_logs
      ORDER BY datetime(taken_at) DESC, id DESC
    `).all() as unknown as HealthSupplementLogRow[]
    const dailyPlans = db.prepare(`
      SELECT * FROM health_daily_plans
      ORDER BY date(plan_date) DESC, datetime(created_at) DESC, id DESC
    `).all() as unknown as HealthDailyPlanRow[]
    const dailyCheckins = db.prepare('SELECT * FROM health_daily_checkins ORDER BY date(checkin_date) DESC, id DESC').all() as Array<Record<string, unknown>>

    return {
      generatedAt: nowIso(),
      profile,
      healthProfile,
      weightSummary: buildWeightSummary(healthProfile, records),
      nutritionSummary: buildNutritionSummary(healthProfile.nutritionTargets, foodLogs),
      recentWorkouts: workouts.slice(0, 10).map(rowToWorkoutSummary),
      topBodyConcerns: buildTopBodyConcerns(bodyMapRows),
      latestPlan: dailyPlans[0] ? rowToDailyPlanSummary(dailyPlans[0]) : null,
      supplementSummary: buildSupplementSummary(supplements, supplementLogs),
      bodyMap: bodyMapRows.map(rowToBodyMapRecord),
      records: records.map(rowToHealthRecord),
      workouts: workouts.map(rowToWorkoutRecord),
      foodItems,
      foodLogs: foodLogs.map(rowToFoodLogRecord),
      foodTemplates,
      supplements: supplements.map(rowToSupplementRecord),
      supplementLogs: supplementLogs.map(rowToSupplementLogRecord),
      dailyPlans: dailyPlans.map(rowToDailyPlanSummary),
      dailyCheckins,
    }
  } finally {
    db.close()
  }
}

function rowToHealthProfile(row: HealthProfileRow | undefined): HealthProfile {
  if (!row) return emptyHealthProfile()
  return {
    displayName: row.display_name,
    birthDate: row.birth_date,
    sex: row.sex,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    weightTargetKg: row.weight_target_kg,
    activityLevel: row.activity_level,
    goals: parseJson(row.goals_json, []),
    conditions: parseJson(row.conditions_json, []),
    allergies: parseJson(row.allergies_json, []),
    nutritionTargets: numericRecord(parseJson(row.nutrition_targets_json, {})),
  }
}

function emptyHealthProfile(): HealthProfile {
  return {
    displayName: null,
    birthDate: null,
    sex: null,
    heightCm: null,
    weightKg: null,
    weightTargetKg: null,
    activityLevel: null,
    goals: [],
    conditions: [],
    allergies: [],
    nutritionTargets: {},
  }
}

function buildWeightSummary(profile: HealthProfile, records: HealthRecordRow[]): HealthWeightSummary {
  const weightRecords = records
    .filter(record => record.kind === 'weight')
    .slice()
    .sort((left, right) => new Date(left.recorded_at).getTime() - new Date(right.recorded_at).getTime())
  const current = weightRecords.at(-1)
  const previous = weightRecords.length > 1 ? weightRecords.at(-2) : undefined
  const currentKg = current ? numericValue(parseJson(current.value_json, null)) : profile.weightKg
  const previousKg = previous ? numericValue(parseJson(previous.value_json, null)) : null
  return {
    currentKg,
    previousKg,
    deltaKg: currentKg !== null && previousKg !== null ? round(currentKg - previousKg) : null,
    targetKg: profile.weightTargetKg,
  }
}

const NUTRITION_KEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'water']

function buildNutritionSummary(targets: Record<string, number>, foodLogs: HealthFoodLogRow[]): HealthNutritionSummary {
  const today = new Date().toISOString().slice(0, 10)
  const normalizedTargets = withNutritionDefaults(targets)
  const consumed = Object.fromEntries(NUTRITION_KEYS.map(key => [key, 0])) as Record<string, number>
  foodLogs
    .filter(log => log.logged_at.slice(0, 10) === today)
    .forEach(log => {
      const nutrition = numericRecord(parseJson(log.nutrition_json, {}))
      NUTRITION_KEYS.forEach(key => {
        consumed[key] = round((consumed[key] || 0) + (nutrition[key] || 0))
      })
    })
  const remaining = Object.fromEntries(NUTRITION_KEYS.map(key => [key, round((normalizedTargets[key] || 0) - (consumed[key] || 0))])) as Record<string, number>
  return { targets: normalizedTargets, consumed, remaining }
}

function withNutritionDefaults(targets: Record<string, number>): Record<string, number> {
  return Object.fromEntries(NUTRITION_KEYS.map(key => [key, Number(targets[key] || 0)])) as Record<string, number>
}

function buildTopBodyConcerns(rows: HealthBodyMapRow[]): HealthBodyConcern[] {
  return rows
    .map(row => {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
      const priority = typeof payload.priority === 'string' ? payload.priority : null
      const developmentLevel = nullableNumber(payload.development_level)
      const activationLevel = nullableNumber(payload.activation_level)
      const postureConstraintLevel = nullableNumber(payload.posture_constraint_level)
      const score = concernScore(priority, developmentLevel, activationLevel, postureConstraintLevel)
      return {
        id: row.id,
        region: row.region,
        status: row.status,
        priority,
        developmentLevel,
        activationLevel,
        postureConstraintLevel,
        notes: row.notes,
        score,
      }
    })
    .sort((left, right) => right.score - left.score || left.region.localeCompare(right.region))
    .slice(0, 8)
}

function concernScore(
  priority: string | null,
  developmentLevel: number | null,
  activationLevel: number | null,
  postureConstraintLevel: number | null,
): number {
  let score = 0
  if (priority === 'high') score += 50
  else if (priority === 'medium') score += 25
  if (developmentLevel !== null) score += Math.max(0, 5 - developmentLevel) * 4
  if (activationLevel !== null) score += Math.max(0, 5 - activationLevel) * 4
  if (postureConstraintLevel !== null) score += postureConstraintLevel * 6
  return round(score)
}

function buildSupplementSummary(supplements: HealthSupplementRow[], logs: HealthSupplementLogRow[]): HealthSupplementSummary {
  const today = new Date().toISOString().slice(0, 10)
  const completedIds = new Set(
    logs
      .filter(log => log.taken_at.slice(0, 10) === today && log.supplement_id)
      .map(log => log.supplement_id as string),
  )
  const active = supplements.filter(item => item.active !== 0)
  const items = active.map(item => ({
    id: item.id,
    name: item.name,
    dosage: item.dosage,
    active: true,
    completedToday: completedIds.has(item.id),
  }))
  const completedToday = items.filter(item => item.completedToday).length
  return {
    total: items.length,
    completedToday,
    remainingToday: Math.max(0, items.length - completedToday),
    items,
  }
}

function rowToWorkoutSummary(row: HealthWorkoutRow): HealthWorkoutSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    durationMinutes: row.duration_minutes,
    intensity: row.intensity,
    notes: row.notes,
    startedAt: row.started_at,
  }
}

function rowToDailyPlanSummary(row: HealthDailyPlanRow): HealthDailyPlanSummary {
  return {
    id: row.id,
    planDate: row.plan_date,
    targets: parseJson(row.targets_json, {}),
    meals: parseJson(row.meals_json, []),
    workouts: parseJson(row.workouts_json, []),
    supplements: parseJson(row.supplements_json, []),
    notes: row.notes,
  }
}

function rowToBodyMapRecord(row: HealthBodyMapRow): Record<string, unknown> {
  return {
    id: row.id,
    region: row.region,
    status: row.status,
    notes: row.notes,
    payload: parseJson(row.payload_json, {}),
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToHealthRecord(row: HealthRecordRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    value: parseJson(row.value_json, null),
    unit: row.unit,
    source: row.source,
    notes: row.notes,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToWorkoutRecord(row: HealthWorkoutRow): Record<string, unknown> {
  return {
    ...rowToWorkoutSummary(row),
    metrics: parseJson(row.metrics_json, {}),
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToFoodLogRecord(row: HealthFoodLogRow): Record<string, unknown> {
  return {
    id: row.id,
    foodItemId: row.food_item_id,
    meal: row.meal,
    quantity: row.quantity,
    unit: row.unit,
    nutrition: parseJson(row.nutrition_json, {}),
    loggedAt: row.logged_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSupplementRecord(row: HealthSupplementRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    dosage: row.dosage,
    schedule: parseJson(row.schedule_json, {}),
    notes: row.notes,
    active: row.active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSupplementLogRecord(row: HealthSupplementLogRow): Record<string, unknown> {
  return {
    id: row.id,
    supplementId: row.supplement_id,
    dosage: row.dosage,
    takenAt: row.taken_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  Object.entries(value).forEach(([key, item]) => {
    const numeric = nullableNumber(item)
    if (numeric !== null) result[key] = numeric
  })
  return result
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && 'value' in value) return nullableNumber((value as { value?: unknown }).value)
  return null
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
