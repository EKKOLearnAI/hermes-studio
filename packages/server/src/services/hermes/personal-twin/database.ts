import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'
import { TWIN_DOMAINS } from './types'

const SCHEMA_VERSION = 4
const REQUIRED_TWIN_TABLES = [
  'twin_artifacts', 'twin_assistant_roles', 'twin_constraints', 'twin_context_recipes',
  'twin_entities', 'twin_events', 'twin_goals', 'twin_import_runs', 'twin_meta',
  'twin_observations', 'twin_outbox', 'twin_preference_operations', 'twin_preferences', 'twin_projections',
  'twin_relations', 'twin_role_profile_mappings',
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
    db.exec('CREATE TABLE IF NOT EXISTS twin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    const version = parseSchemaVersion(row?.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Personal Twin schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
    }
    if (version < 1) {
      createSchemaV1(db)
      setSchemaVersion(db, 1)
    }
    if (version < 2) {
      createSchemaV2(db)
      setSchemaVersion(db, 2)
    }
    if (version < 3) {
      createSchemaV3(db)
      setSchemaVersion(db, 3)
    }
    if (version < 4) {
      createSchemaV4(db)
      setSchemaVersion(db, 4)
    }
    assertSchemaComplete(db, SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(`
    INSERT INTO twin_meta(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version))
}

function parseSchemaVersion(value: string | undefined): number {
  if (value === undefined) return 0
  const version = Number(value)
  if (!Number.isInteger(version) || version < 0) throw new Error(`Personal Twin schema version is invalid: ${value}`)
  return version
}

function assertSchemaComplete(db: DatabaseSync, version: number): void {
  const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'twin_%'").all() as Array<{ name: string }>).map(row => row.name))
  const missing = REQUIRED_TWIN_TABLES.filter(name => !names.has(name))
  if (missing.length > 0) throw new Error(`Personal Twin schema version ${version} is incomplete: missing ${missing.join(', ')}`)
  const preferenceColumns = new Set((db.prepare("PRAGMA table_info('twin_preferences')").all() as Array<{ name: string }>).map(row => row.name))
  const missingColumns = ['actor', 'version'].filter(name => !preferenceColumns.has(name))
  if (missingColumns.length > 0) throw new Error(`Personal Twin schema version ${version} is incomplete: twin_preferences missing ${missingColumns.join(', ')}`)
  const addressIndex = (db.prepare("PRAGMA index_list('twin_preferences')").all() as Array<{
    name: string; unique: number; partial: number
  }>).find(index => index.name === 'idx_twin_preferences_address')
  const addressColumns = addressIndex
    ? (db.prepare("PRAGMA index_info('idx_twin_preferences_address')").all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map(column => column.name)
    : []
  if (!addressIndex || addressIndex.unique !== 1 || addressIndex.partial !== 0
    || addressColumns.length !== 2 || addressColumns[0] !== 'subject_id' || addressColumns[1] !== 'key') {
    throw new Error(`Personal Twin schema version ${version} is incomplete: unique preference address index signature is invalid`)
  }
}

function createSchemaV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_entities (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL, source_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_entities_type ON twin_entities(type);

    CREATE TABLE IF NOT EXISTS twin_relations (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_id TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}', valid_from TEXT, valid_to TEXT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source, source_id), FOREIGN KEY(subject_id) REFERENCES twin_entities(id), FOREIGN KEY(object_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_relations_subject ON twin_relations(subject_id, predicate);
    CREATE INDEX IF NOT EXISTS idx_twin_relations_object ON twin_relations(object_id, predicate);

    CREATE TABLE IF NOT EXISTS twin_observations (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, metric TEXT NOT NULL, value_json TEXT NOT NULL,
      unit TEXT, observed_at TEXT NOT NULL, ingested_at TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
      actor TEXT NOT NULL, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('observed','reported','confirmed','inferred')),
      evidence_json TEXT NOT NULL DEFAULT '[]', schema_version INTEGER NOT NULL,
      UNIQUE(source, source_id, metric), FOREIGN KEY(entity_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_observations_lookup ON twin_observations(entity_id, metric, observed_at DESC);

    CREATE TABLE IF NOT EXISTS twin_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, subject_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
      actor TEXT NOT NULL, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('observed','reported','confirmed','inferred')),
      evidence_json TEXT NOT NULL DEFAULT '[]', schema_version INTEGER NOT NULL,
      UNIQUE(source, source_id, event_type), FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_events_lookup ON twin_events(subject_id, event_type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS twin_goals (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL,
      target_json TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, starts_at TEXT, due_at TEXT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source, source_id), FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE TABLE IF NOT EXISTS twin_preferences (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1), source TEXT NOT NULL, source_id TEXT NOT NULL,
      actor TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, source_id), FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE TABLE IF NOT EXISTS twin_constraints (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, domain TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
      enforcement TEXT NOT NULL CHECK(enforcement IN ('hard','advisory')), source TEXT NOT NULL, source_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, source_id), FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE TABLE IF NOT EXISTS twin_projections (
      projection_key TEXT NOT NULL, subject_id TEXT NOT NULL, value_json TEXT NOT NULL, source_record_id TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(projection_key, subject_id), FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE TABLE IF NOT EXISTS twin_artifacts (
      id TEXT PRIMARY KEY, media_type TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twin_outbox (
      id TEXT PRIMARY KEY, topic TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','published','failed')), attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, locked_until TEXT, created_at TEXT NOT NULL, published_at TEXT,
      UNIQUE(topic, aggregate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_outbox_pending ON twin_outbox(status, available_at);
    CREATE TABLE IF NOT EXISTS twin_import_runs (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, counts_json TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL,
      completed_at TEXT, UNIQUE(source, source_fingerprint)
    );
  `)
}

function createSchemaV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_assistant_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      persona TEXT NOT NULL,
      built_in INTEGER NOT NULL CHECK(built_in IN (0,1)),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      data_scope_json TEXT NOT NULL,
      capability_scope_json TEXT NOT NULL,
      decision_authority_json TEXT NOT NULL DEFAULT '{}',
      spending_limits_json TEXT NOT NULL DEFAULT '{}',
      memory_namespace TEXT NOT NULL UNIQUE,
      escalation_rules_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_role_profile_mappings (
      role_id TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(role_id, profile_name),
      FOREIGN KEY(role_id) REFERENCES twin_assistant_roles(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_role_primary_profile
      ON twin_role_profile_mappings(profile_name) WHERE is_primary = 1;

    CREATE TABLE IF NOT EXISTS twin_context_recipes (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      built_in INTEGER NOT NULL CHECK(built_in IN (0,1)),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      domains_json TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      query_template TEXT NOT NULL DEFAULT '',
      limits_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(role_id, name),
      FOREIGN KEY(role_id) REFERENCES twin_assistant_roles(id) ON DELETE CASCADE
    );
  `)
}

function createSchemaV3(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info('twin_preferences')").all() as Array<{ name: string }>).map(row => row.name))
  if (!columns.has('actor')) {
    db.exec("ALTER TABLE twin_preferences ADD COLUMN actor TEXT NOT NULL DEFAULT ''")
    db.exec("UPDATE twin_preferences SET actor=source WHERE actor='' OR actor IS NULL")
  }
  if (!columns.has('version')) db.exec('ALTER TABLE twin_preferences ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_preference_operations (
      operation_id TEXT PRIMARY KEY,
      material_digest TEXT NOT NULL CHECK(length(material_digest)=64),
      kind TEXT NOT NULL CHECK(kind IN ('set','delete')),
      subject_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      result_snapshot_json TEXT NOT NULL CHECK(length(CAST(result_snapshot_json AS BLOB)) <= 12000 AND json_valid(result_snapshot_json)),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64),
      status TEXT NOT NULL CHECK(status='applied'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_preference_operations_address
      ON twin_preference_operations(subject_id,domain,key,created_at);
    CREATE TRIGGER IF NOT EXISTS trg_twin_preference_operations_no_update
      BEFORE UPDATE ON twin_preference_operations BEGIN
        SELECT RAISE(ABORT, 'twin preference operations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS trg_twin_preference_operations_no_delete
      BEFORE DELETE ON twin_preference_operations BEGIN
        SELECT RAISE(ABORT, 'twin preference operations are immutable');
      END;
  `)
}

function isSensitivePreferenceKey(key: string): boolean {
  return /(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key)/i.test(key)
}

function isValidPreferenceKey(key: string): boolean {
  return key.length >= 1 && key.length <= 160
    && /^[a-z0-9][a-z0-9._-]*$/i.test(key)
    && !key.startsWith('_')
    && !/^(?:system|internal|admin)\./i.test(key)
    && !isSensitivePreferenceKey(key)
}

function canonicalPreferenceAddress(id: string, storedKey: string): string {
  const separator = storedKey.indexOf(':')
  if (separator === -1) {
    if (!isValidPreferenceKey(storedKey)) {
      throw new Error(`Personal Twin preference record ${id} has an invalid legacy key: ${JSON.stringify(storedKey)}`)
    }
    return `life:${storedKey}`
  }
  const domain = storedKey.slice(0, separator)
  const key = storedKey.slice(separator + 1)
  if (!(TWIN_DOMAINS as readonly string[]).includes(domain) || !isValidPreferenceKey(key)) {
    throw new Error(`Personal Twin preference record ${id} has an invalid canonical key: ${JSON.stringify(storedKey)}`)
  }
  return storedKey
}

function createSchemaV4(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id,subject_id,key FROM twin_preferences ORDER BY id').all() as Array<{
    id: string; subject_id: string; key: string
  }>
  const mapped = rows.map(row => ({ ...row, canonicalKey: canonicalPreferenceAddress(row.id, row.key) }))
  const owners = new Map<string, string>()
  for (const row of mapped) {
    const address = `${row.subject_id}\0${row.canonicalKey}`
    const owner = owners.get(address)
    if (owner !== undefined) {
      throw new Error(`Personal Twin preference migration has duplicate address for records ${owner} and ${row.id}`)
    }
    owners.set(address, row.id)
  }
  const update = db.prepare('UPDATE twin_preferences SET key=? WHERE id=?')
  for (const row of mapped) {
    if (row.key !== row.canonicalKey) update.run(row.canonicalKey, row.id)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_preferences_address ON twin_preferences(subject_id,key)')
}
