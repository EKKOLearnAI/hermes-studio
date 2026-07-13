import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'
import { TWIN_DOMAINS } from './types'

const SCHEMA_VERSION = 5
const REQUIRED_TWIN_TABLES = [
  'twin_artifacts', 'twin_artifact_consents', 'twin_assistant_roles', 'twin_constraints', 'twin_context_recipes',
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
      try {
        createSchemaV4(db)
      } catch (error) {
        if (error instanceof TwinPreferenceMigrationError) {
          throw error
        }
        throw new Error('TWIN_PREFERENCE_MIGRATION_FAILED')
      }
      setSchemaVersion(db, 4)
    }
    if (version < 5) {
      createSchemaV5(db)
      setSchemaVersion(db, 5)
    }
    normalizeLegacyArtifactSourceIndex(db)
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
  const artifactColumns = db.prepare("PRAGMA table_info('twin_artifacts')").all() as unknown as ColumnInfo[]
  const expectedArtifactColumns: ColumnSignature[] = [
    ['id', 'TEXT', 0, 1, null], ['media_type', 'TEXT', 1, 0, null], ['content_hash', 'TEXT', 1, 0, null],
    ['relative_path', 'TEXT', 1, 0, null], ['size_bytes', 'INTEGER', 1, 0, null], ['source', 'TEXT', 1, 0, null],
    ['source_id', 'TEXT', 1, 0, null], ['created_at', 'TEXT', 1, 0, null],
    ['sensitivity', 'TEXT', 1, 0, "'general'"], ['metadata_json', 'TEXT', 1, 0, "'{}'"],
  ]
  if (!columnsMatch(artifactColumns, expectedArtifactColumns)) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: twin_artifacts column signature is invalid`)
  }
  assertIndexSignature(db, version, 'twin_artifacts', 'idx_twin_artifacts_source_identity', ['source', 'source_id'], false)
  const contentHashIndexes = db.prepare("PRAGMA index_list('twin_artifacts')").all() as Array<{
    name: string; unique: number; partial: number
  }>
  const hasUniqueContentHash = contentHashIndexes.some(index => index.unique === 1 && index.partial === 0
    && indexColumns(db, index.name).length === 1 && indexColumns(db, index.name)[0] === 'content_hash')
  if (!hasUniqueContentHash) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: unique artifact content hash index signature is invalid`)
  }
  const consentColumns = db.prepare("PRAGMA table_info('twin_artifact_consents')").all() as unknown as ColumnInfo[]
  const expectedConsentColumns: ColumnSignature[] = [
    ['manifest_digest', 'TEXT', 0, 1, null], ['processor', 'TEXT', 1, 0, null],
    ['scope_json', 'TEXT', 1, 0, null], ['issued_at', 'TEXT', 1, 0, null], ['expires_at', 'TEXT', 1, 0, null],
    ['consumed_at', 'TEXT', 0, 0, null], ['revoked_at', 'TEXT', 0, 0, null],
  ]
  if (!columnsMatch(consentColumns, expectedConsentColumns)) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: twin_artifact_consents signature is invalid`)
  }
  assertIndexSignature(db, version, 'twin_artifact_consents', 'idx_twin_artifact_consents_status',
    ['processor', 'expires_at', 'consumed_at', 'revoked_at'], false)
}

interface ColumnInfo { name: string; type: string; notnull: number; pk: number; dflt_value: string | null }
type ColumnSignature = [name: string, type: string, notnull: number, pk: number, defaultValue: string | null]

function columnsMatch(actual: ColumnInfo[], expected: ColumnSignature[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => {
    const signature = expected[index]
    return column.name === signature[0] && column.type.toUpperCase() === signature[1]
      && column.notnull === signature[2] && column.pk === signature[3] && column.dflt_value === signature[4]
  })
}

function indexColumns(db: DatabaseSync, indexName: string): string[] {
  return (db.prepare(`PRAGMA index_info('${indexName.replace(/'/g, "''")}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map(column => column.name)
}

function assertIndexSignature(
  db: DatabaseSync,
  version: number,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
): void {
  const index = (db.prepare(`PRAGMA index_list('${table.replace(/'/g, "''")}')`).all() as Array<{
    name: string; unique: number; partial: number
  }>).find(candidate => candidate.name === indexName)
  const actualColumns = index ? indexColumns(db, indexName) : []
  if (!index || index.unique !== Number(unique) || index.partial !== 0
    || actualColumns.length !== columns.length || actualColumns.some((column, position) => column !== columns[position])) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} index signature is invalid`)
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

class TwinPreferenceMigrationError extends Error {}

function isValidPreferenceKey(key: string): boolean {
  return key.length >= 1 && key.length <= 160
    && /^[a-z0-9][a-z0-9._-]*$/i.test(key)
    && !key.startsWith('_')
    && !/^(?:system|internal|admin)\./i.test(key)
    && !isSensitivePreferenceKey(key)
}

function preferenceRecordRef(id: string): string {
  const digest = createHash('sha256').update('personal-twin-preference-record\0', 'utf8')
    .update(String(id), 'utf8').digest('hex')
  return `record-${digest.slice(0, 24)}`
}

function canonicalPreferenceAddress(id: string, storedKey: string): string {
  const separator = storedKey.indexOf(':')
  if (separator === -1) {
    if (!isValidPreferenceKey(storedKey)) {
      throw new TwinPreferenceMigrationError(`TWIN_PREFERENCE_LEGACY_KEY_INVALID record=${preferenceRecordRef(id)}`)
    }
    return `life:${storedKey}`
  }
  const domain = storedKey.slice(0, separator)
  const key = storedKey.slice(separator + 1)
  if (!(TWIN_DOMAINS as readonly string[]).includes(domain) || !isValidPreferenceKey(key)) {
    throw new TwinPreferenceMigrationError(`TWIN_PREFERENCE_LEGACY_KEY_INVALID record=${preferenceRecordRef(id)}`)
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
      throw new TwinPreferenceMigrationError(`TWIN_PREFERENCE_LEGACY_KEY_COLLISION records=${preferenceRecordRef(owner)},${preferenceRecordRef(row.id)}`)
    }
    owners.set(address, row.id)
  }
  const update = db.prepare('UPDATE twin_preferences SET key=? WHERE id=?')
  for (const row of mapped) {
    if (row.key !== row.canonicalKey) update.run(row.canonicalKey, row.id)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_preferences_address ON twin_preferences(subject_id,key)')
}

function createSchemaV5(db: DatabaseSync): void {
  const artifactColumns = new Set((db.prepare("PRAGMA table_info('twin_artifacts')").all() as Array<{ name: string }>).map(row => row.name))
  if (!artifactColumns.has('sensitivity')) {
    db.exec("ALTER TABLE twin_artifacts ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'general' CHECK(sensitivity IN ('health','general'))")
  }
  if (!artifactColumns.has('metadata_json')) {
    db.exec("ALTER TABLE twin_artifacts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 8192)")
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_twin_artifacts_source_identity
      ON twin_artifacts(source, source_id);
    CREATE TABLE IF NOT EXISTS twin_artifact_consents (
      manifest_digest TEXT PRIMARY KEY CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
      processor TEXT NOT NULL,
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND length(CAST(scope_json AS BLOB)) <= 8192),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_twin_artifact_consents_status
      ON twin_artifact_consents(processor, expires_at, consumed_at, revoked_at);
  `)
}

function normalizeLegacyArtifactSourceIndex(db: DatabaseSync): void {
  const index = (db.prepare("PRAGMA index_list('twin_artifacts')").all() as Array<{
    name: string; unique: number; partial: number
  }>).find(candidate => candidate.name === 'idx_twin_artifacts_source_identity')
  if (index?.unique === 1 && index.partial === 0
    && indexColumns(db, index.name).join('\0') === ['source', 'source_id'].join('\0')) {
    db.exec(`DROP INDEX idx_twin_artifacts_source_identity;
      CREATE INDEX idx_twin_artifacts_source_identity ON twin_artifacts(source, source_id)`)
  }
}
