import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 1
const REQUIRED_TWIN_TABLES = [
  'twin_artifacts',
  'twin_constraints',
  'twin_entities',
  'twin_events',
  'twin_goals',
  'twin_import_runs',
  'twin_meta',
  'twin_observations',
  'twin_outbox',
  'twin_preferences',
  'twin_projections',
  'twin_relations',
]

export function getPersonalTwinDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'twin.db')
}

export function withPersonalTwinDb<T>(callback: (db: DatabaseSync) => T): T {
  const path = getPersonalTwinDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    initPersonalTwinSchema(db)
    return callback(db)
  } finally {
    db.close()
  }
}

export function initPersonalTwinSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS twin_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    const row = db.prepare(
      "SELECT value FROM twin_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined
    const version = parseSchemaVersion(row?.value)

    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Personal Twin schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
      )
    }

    if (version < SCHEMA_VERSION) {
      migrateToVersionOne(db)
      db.prepare(`
        INSERT INTO twin_meta(key, value) VALUES('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(SCHEMA_VERSION))
    }

    assertSchemaComplete(db, SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function parseSchemaVersion(value: string | undefined): number {
  if (value === undefined) return 0
  const version = Number(value)
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Personal Twin schema version is invalid: ${value}`)
  }
  return version
}

function assertSchemaComplete(db: DatabaseSync, version: number): void {
  const names = new Set((db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'twin_%'
  `).all() as Array<{ name: string }>).map(row => row.name))
  const missing = REQUIRED_TWIN_TABLES.filter(name => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Personal Twin schema version ${version} is incomplete: missing ${missing.join(', ')}`,
    )
  }
}

function migrateToVersionOne(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_entities_type ON twin_entities(type);

    CREATE TABLE IF NOT EXISTS twin_relations (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT,
      valid_to TEXT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id),
      FOREIGN KEY(object_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_relations_subject
      ON twin_relations(subject_id, predicate);
    CREATE INDEX IF NOT EXISTS idx_twin_relations_object
      ON twin_relations(object_id, predicate);

    CREATE TABLE IF NOT EXISTS twin_observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value_json TEXT NOT NULL,
      unit TEXT,
      observed_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      confirmation_state TEXT NOT NULL
        CHECK(confirmation_state IN ('observed', 'reported', 'confirmed', 'inferred')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
      UNIQUE(source, source_id, metric),
      FOREIGN KEY(entity_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_observations_lookup
      ON twin_observations(entity_id, metric, observed_at DESC);

    CREATE TABLE IF NOT EXISTS twin_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      subject_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      confirmation_state TEXT NOT NULL
        CHECK(confirmation_state IN ('observed', 'reported', 'confirmed', 'inferred')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
      UNIQUE(source, source_id, event_type),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_events_lookup
      ON twin_events(subject_id, event_type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS twin_goals (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      starts_at TEXT,
      due_at TEXT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_preferences (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_constraints (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      enforcement TEXT NOT NULL CHECK(enforcement IN ('hard', 'advisory')),
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_projections (
      projection_key TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(projection_key, subject_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_artifacts (
      id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_outbox (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      available_at TEXT NOT NULL,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(topic, aggregate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_outbox_pending
      ON twin_outbox(status, available_at);

    CREATE TABLE IF NOT EXISTS twin_import_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      counts_json TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(source, source_fingerprint)
    );
  `)
}
