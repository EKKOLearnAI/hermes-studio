import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getProfileDir } from './hermes-profile'

const SCHEMA_VERSION = 1

function id(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

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

export interface HealthExternalSummary {
  currentWeightKg: number | null
  targetWeightKg: number | null
  topRegions: HealthBodyConcern[]
  recentWorkoutCount: number
}

export interface HealthInternalMarker {
  id: string
  key: string
  label: string
  value: number | string | null
  unit: string | null
  status: string
  source: string
  recordedAt: string
  referenceRange: string | null
  notes: string
}

export interface HealthMicronutrientSummary {
  items: Array<{
    key: string
    consumed: number
    target: number
    remaining: number
    status: 'low' | 'ok' | 'high' | 'unknown'
  }>
}

export interface HealthDigitalTwinSummary {
  currentWeightKg: number | null
  targetWeightKg: number | null
  externalConcernCount: number
  internalMarkerCount: number
  micronutrientGapCount: number
}

export interface HealthOverview {
  generatedAt: string
  profile: string
  healthProfile: HealthProfile
  weightSummary: HealthWeightSummary
  nutritionSummary: HealthNutritionSummary
  recentWorkouts: HealthWorkoutSummary[]
  topBodyConcerns: HealthBodyConcern[]
  digitalTwinSummary: HealthDigitalTwinSummary
  externalSummary: HealthExternalSummary
  internalMarkers: HealthInternalMarker[]
  micronutrientSummary: HealthMicronutrientSummary
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
  dailyPlans: HealthDailyPlanSummary[]
  dailyCheckins: Array<Record<string, unknown>>
}

interface HealthProfileRow {
  id: string
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
  created_at: string
  updated_at: string
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
    const weightSummary = buildWeightSummary(healthProfile, records)
    const nutritionSummary = buildNutritionSummary(healthProfile.nutritionTargets, foodLogs)
    const recentWorkouts = workouts.slice(0, 10).map(rowToWorkoutSummary)
    const topBodyConcerns = buildTopBodyConcerns(bodyMapRows)
    const internalMarkers = buildInternalMarkers(records)
    const micronutrientSummary = buildMicronutrientSummary(healthProfile.nutritionTargets, foodLogs)
    const externalSummary = buildExternalSummary(weightSummary, topBodyConcerns, recentWorkouts)

    return {
      generatedAt: nowIso(),
      profile,
      healthProfile,
      weightSummary,
      nutritionSummary,
      recentWorkouts,
      topBodyConcerns,
      digitalTwinSummary: buildDigitalTwinSummary(weightSummary, topBodyConcerns, internalMarkers, micronutrientSummary),
      externalSummary,
      internalMarkers,
      micronutrientSummary,
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

export function getHealthProfile(profile?: string): HealthProfile {
  return getHealthOverview({ profile }).healthProfile
}

export function updateHealthProfile(input: Record<string, unknown>, _actor = 'user', profile?: string): HealthProfile {
  const db = openHealthStateDb(profile)
  try {
    const updatedAt = nowIso()
    const current = db.prepare('SELECT * FROM health_profile ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1').get() as HealthProfileRow | undefined
    const next = {
      displayName: text(input.displayName ?? input.display_name ?? current?.display_name),
      birthDate: text(input.birthDate ?? input.birth_date ?? current?.birth_date),
      sex: text(input.sex ?? current?.sex),
      heightCm: nullableNumber(input.heightCm ?? input.height_cm ?? current?.height_cm),
      weightKg: nullableNumber(input.weightKg ?? input.weight_kg ?? current?.weight_kg),
      weightTargetKg: nullableNumber(input.weightTargetKg ?? input.weight_target_kg ?? current?.weight_target_kg),
      activityLevel: text(input.activityLevel ?? input.activity_level ?? current?.activity_level),
      goals: Array.isArray(input.goals) ? input.goals : parseJson(current?.goals_json, []),
      conditions: Array.isArray(input.conditions) ? input.conditions : parseJson(current?.conditions_json, []),
      allergies: Array.isArray(input.allergies) ? input.allergies : parseJson(current?.allergies_json, []),
      nutritionTargets: input.nutritionTargets && typeof input.nutritionTargets === 'object'
        ? input.nutritionTargets
        : parseJson(current?.nutrition_targets_json, {}),
    }
    db.prepare(`
      INSERT INTO health_profile (
        id, display_name, birth_date, sex, height_cm, weight_kg, weight_target_kg,
        activity_level, goals_json, conditions_json, allergies_json, nutrition_targets_json,
        created_at, updated_at
      )
      VALUES ('profile-default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        birth_date=excluded.birth_date,
        sex=excluded.sex,
        height_cm=excluded.height_cm,
        weight_kg=excluded.weight_kg,
        weight_target_kg=excluded.weight_target_kg,
        activity_level=excluded.activity_level,
        goals_json=excluded.goals_json,
        conditions_json=excluded.conditions_json,
        allergies_json=excluded.allergies_json,
        nutrition_targets_json=excluded.nutrition_targets_json,
        updated_at=excluded.updated_at
    `).run(
      next.displayName,
      next.birthDate,
      next.sex,
      next.heightCm,
      next.weightKg,
      next.weightTargetKg,
      next.activityLevel,
      JSON.stringify(next.goals),
      JSON.stringify(next.conditions),
      JSON.stringify(next.allergies),
      JSON.stringify(next.nutritionTargets),
      current?.created_at || updatedAt,
      updatedAt,
    )
  } finally {
    db.close()
  }
  return getHealthProfile(profile)
}

export function getHealthBodyMap(profile?: string): Array<Record<string, unknown>> {
  return getHealthOverview({ profile }).bodyMap
}

export function updateHealthBodyMap(input: unknown, _actor = 'user', profile?: string): Array<Record<string, unknown>> {
  const entries = Array.isArray(input) ? input : []
  const db = openHealthStateDb(profile)
  try {
    const updatedAt = nowIso()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const region = text(item.region)
      if (!region) continue
      const bodyMapId = text(item.id) || `body-${region}`
      db.prepare(`
        INSERT INTO health_body_map (id, region, status, notes, payload_json, recorded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          region=excluded.region,
          status=excluded.status,
          notes=excluded.notes,
          payload_json=excluded.payload_json,
          recorded_at=excluded.recorded_at,
          updated_at=excluded.updated_at
      `).run(
        bodyMapId,
        region,
        text(item.status || 'active'),
        text(item.notes),
        JSON.stringify(item.payload || item),
        text(item.recordedAt || item.recorded_at || updatedAt),
        updatedAt,
        updatedAt,
      )
    }
  } finally {
    db.close()
  }
  return getHealthBodyMap(profile)
}

export function listHealthRecords(profile?: string): Array<Record<string, unknown>> {
  return getHealthOverview({ profile }).records
}

export function createHealthRecord(input: Record<string, unknown>, actor = 'user', profile?: string): Record<string, unknown> {
  const db = openHealthStateDb(profile)
  const recordId = text(input.id) || id('health-record')
  const kind = text(input.kind || input.category || 'metric')
  try {
    const createdAt = nowIso()
    const value = Object.prototype.hasOwnProperty.call(input, 'value') ? { value: input.value } : input.valueJson || input.value_json || null
    db.prepare(`
      INSERT INTO health_records (id, kind, title, value_json, unit, source, notes, recorded_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      kind,
      text(input.title || kind),
      JSON.stringify(value),
      text(input.unit),
      text(input.source || actor),
      text(input.notes),
      text(input.recordedAt || input.recorded_at || createdAt),
      createdAt,
      createdAt,
    )
  } finally {
    db.close()
  }
  return listHealthRecords(profile).find(record => record.id === recordId) || { id: recordId, kind }
}

export function listHealthWorkouts(profile?: string): Array<Record<string, unknown>> {
  return getHealthOverview({ profile }).workouts
}

export function createHealthWorkout(input: Record<string, unknown>, _actor = 'user', profile?: string): Record<string, unknown> {
  const db = openHealthStateDb(profile)
  const workoutId = text(input.id) || id('health-workout')
  try {
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO health_workouts (
        id, kind, title, duration_minutes, intensity, metrics_json, notes, started_at, ended_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workoutId,
      text(input.kind || 'workout'),
      text(input.title || input.exerciseType || input.exercise_type || 'Workout'),
      nullableNumber(input.durationMinutes ?? input.duration_minutes ?? input.duration),
      text(input.intensity),
      JSON.stringify(input.metrics || {}),
      text(input.notes),
      text(input.startedAt || input.started_at || input.workoutAt || input.workout_at || createdAt),
      text(input.endedAt || input.ended_at),
      createdAt,
      createdAt,
    )
  } finally {
    db.close()
  }
  return listHealthWorkouts(profile).find(workout => workout.id === workoutId) || { id: workoutId }
}

export function listHealthFoodItems(profile?: string): Array<Record<string, unknown>> {
  return getHealthOverview({ profile }).foodItems
}

export function listHealthFoodLogs(profile?: string): Array<Record<string, unknown>> {
  return getHealthOverview({ profile }).foodLogs
}

export function createHealthFoodLog(input: Record<string, unknown>, _actor = 'user', profile?: string): Record<string, unknown> {
  const db = openHealthStateDb(profile)
  const logId = text(input.id) || id('health-food-log')
  try {
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO health_food_logs (
        id, food_item_id, meal, quantity, unit, nutrition_json, logged_at, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      logId,
      nullableText(input.foodItemId || input.food_item_id),
      text(input.meal || input.mealType || input.meal_type || 'uncategorized'),
      nullableNumber(input.quantity) || 1,
      text(input.unit || 'serving'),
      JSON.stringify(input.nutrition || {}),
      text(input.loggedAt || input.logged_at || createdAt),
      text(input.notes),
      createdAt,
      createdAt,
    )
  } finally {
    db.close()
  }
  return listHealthFoodLogs(profile).find(log => log.id === logId) || { id: logId }
}

export function getTodayHealthPlan(profile?: string): HealthDailyPlanSummary | null {
  return getHealthOverview({ profile }).latestPlan
}

export function createHealthCheckIn(input: Record<string, unknown>, _actor = 'user', profile?: string): Record<string, unknown> {
  const db = openHealthStateDb(profile)
  const checkInId = text(input.id) || id('health-checkin')
  try {
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO health_daily_checkins (
        id, checkin_date, mood, energy, sleep_json, metrics_json, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkInId,
      text(input.checkinDate || input.checkin_date || createdAt.slice(0, 10)),
      text(input.mood),
      nullableNumber(input.energy),
      JSON.stringify(input.sleep || {}),
      JSON.stringify(input.metrics || input),
      text(input.notes),
      createdAt,
      createdAt,
    )
  } finally {
    db.close()
  }
  return getHealthOverview({ profile }).dailyCheckins.find(checkIn => checkIn.id === checkInId) || { id: checkInId }
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
const MICRONUTRIENT_KEYS = new Set([
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
])
const INTERNAL_RECORD_KINDS = new Set(['lab', 'checkup', 'blood', 'urine', 'vitamin', 'mineral', 'micronutrient', 'biomarker', 'vital', 'blood_pressure'])

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

function buildInternalMarkers(records: HealthRecordRow[]): HealthInternalMarker[] {
  return records
    .filter(record => INTERNAL_RECORD_KINDS.has(record.kind))
    .map(record => {
      const value = parseJson<Record<string, unknown>>(record.value_json, {})
      const numeric = numericValue(value)
      const rawValue = value.value
      return {
        id: record.id,
        key: normalizeMarkerKey(nullableText(value.marker) || record.title || record.kind),
        label: record.title,
        value: numeric ?? (typeof rawValue === 'string' ? rawValue : null),
        unit: record.unit,
        status: nullableText(value.status) || inferMarkerStatus(numeric, value),
        source: record.source,
        recordedAt: record.recorded_at,
        referenceRange: nullableText(value.referenceRange ?? value.reference_range),
        notes: record.notes,
      }
    })
}

function buildMicronutrientSummary(targets: Record<string, number>, foodLogs: HealthFoodLogRow[]): HealthMicronutrientSummary {
  const today = new Date().toISOString().slice(0, 10)
  const consumed: Record<string, number> = {}
  foodLogs
    .filter(log => log.logged_at.slice(0, 10) === today)
    .forEach(log => {
      const nutrition = parseJson<Record<string, unknown>>(log.nutrition_json, {})
      const micros = nutrition.micros && typeof nutrition.micros === 'object' ? numericRecord(nutrition.micros as Record<string, unknown>) : {}
      Object.entries(micros).forEach(([key, value]) => {
        consumed[key] = round((consumed[key] || 0) + value)
      })
    })

  const macroKeys = new Set(NUTRITION_KEYS)
  const keys = new Set<string>()
  Object.keys(targets).forEach(key => {
    if (!macroKeys.has(key) && MICRONUTRIENT_KEYS.has(key)) keys.add(key)
  })
  Object.keys(consumed).forEach(key => {
    if (MICRONUTRIENT_KEYS.has(key)) keys.add(key)
  })

  return {
    items: Array.from(keys)
      .sort((left, right) => left.localeCompare(right))
      .map(key => {
        const target = Number(targets[key] || 0)
        const total = round(consumed[key] || 0)
        const remaining = round(target - total)
        return {
          key,
          consumed: total,
          target,
          remaining,
          status: micronutrientStatus(total, target),
        }
      }),
  }
}

function buildExternalSummary(
  weightSummary: HealthWeightSummary,
  topBodyConcerns: HealthBodyConcern[],
  recentWorkouts: HealthWorkoutSummary[],
): HealthExternalSummary {
  return {
    currentWeightKg: weightSummary.currentKg,
    targetWeightKg: weightSummary.targetKg,
    topRegions: topBodyConcerns.slice(0, 5),
    recentWorkoutCount: recentWorkouts.length,
  }
}

function buildDigitalTwinSummary(
  weightSummary: HealthWeightSummary,
  topBodyConcerns: HealthBodyConcern[],
  internalMarkers: HealthInternalMarker[],
  micronutrientSummary: HealthMicronutrientSummary,
): HealthDigitalTwinSummary {
  return {
    currentWeightKg: weightSummary.currentKg,
    targetWeightKg: weightSummary.targetKg,
    externalConcernCount: topBodyConcerns.length,
    internalMarkerCount: internalMarkers.length,
    micronutrientGapCount: micronutrientSummary.items.filter(item => item.status === 'low').length,
  }
}

function inferMarkerStatus(value: number | null, payload: Record<string, unknown>): string {
  if (value === null) return 'unknown'
  const min = nullableNumber(payload.min ?? payload.low)
  const max = nullableNumber(payload.max ?? payload.high)
  if (min !== null && value < min) return 'low'
  if (max !== null && value > max) return 'high'
  if (min !== null || max !== null) return 'ok'
  return 'unknown'
}

function micronutrientStatus(consumed: number, target: number): 'low' | 'ok' | 'high' | 'unknown' {
  if (!target) return 'unknown'
  if (consumed < target) return 'low'
  if (consumed > target * 1.2) return 'high'
  return 'ok'
}

function normalizeMarkerKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
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

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
