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
  activityLevel: string | null
  goals: string[]
  conditions: string[]
  allergies: string[]
}

export interface HealthOverview {
  generatedAt: string
  profile: string
  healthProfile: HealthProfile
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
  activity_level: string | null
  goals_json: string
  conditions_json: string
  allergies_json: string
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
      activity_level TEXT,
      goals_json TEXT NOT NULL DEFAULT '[]',
      conditions_json TEXT NOT NULL DEFAULT '[]',
      allergies_json TEXT NOT NULL DEFAULT '[]',
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

export function getHealthOverview(options: { profile?: string } | string = {}): HealthOverview {
  const opts = typeof options === 'string' ? { profile: options } : options
  const profile = profileName(opts.profile)
  const db = openHealthStateDb(profile)
  try {
    const row = db.prepare('SELECT * FROM health_profile ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1').get() as HealthProfileRow | undefined

    return {
      generatedAt: nowIso(),
      profile,
      healthProfile: rowToHealthProfile(row),
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
    activityLevel: row.activity_level,
    goals: parseJson(row.goals_json, []),
    conditions: parseJson(row.conditions_json, []),
    allergies: parseJson(row.allergies_json, []),
  }
}

function emptyHealthProfile(): HealthProfile {
  return {
    displayName: null,
    birthDate: null,
    sex: null,
    heightCm: null,
    weightKg: null,
    activityLevel: null,
    goals: [],
    conditions: [],
    allergies: [],
  }
}
