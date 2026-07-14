import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'
import { TWIN_DOMAINS } from './types'

const SCHEMA_VERSION = 11
const RESERVATION_TABLE_SQL = `CREATE TABLE twin_artifact_consent_reservations (
  reservation_id TEXT PRIMARY KEY
    CHECK(length(reservation_id) BETWEEN 48 AND 64 AND reservation_id GLOB 'reservation-*'
      AND reservation_id NOT GLOB '*[^a-zA-Z0-9-]*'),
  consent_id TEXT NOT NULL REFERENCES twin_artifact_consents(consent_id),
  artifact_id TEXT NOT NULL
    CHECK(length(artifact_id)=73 AND artifact_id GLOB 'artifact-*'
      AND substr(artifact_id,10) NOT GLOB '*[^a-f0-9]*'),
  artifact_manifest_digest TEXT NOT NULL
    CHECK(length(artifact_manifest_digest)=64 AND artifact_manifest_digest NOT GLOB '*[^a-f0-9]*'),
  processor TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
)`
const REQUIRED_TWIN_TABLES = [
  'twin_artifacts', 'twin_artifact_consents', 'twin_artifact_consent_reservations', 'twin_assistant_roles', 'twin_constraints', 'twin_context_recipes',
  'twin_entities', 'twin_events', 'twin_goals', 'twin_import_runs', 'twin_meta',
  'twin_observations', 'twin_outbox', 'twin_preference_operations', 'twin_preferences', 'twin_projections',
  'twin_relations', 'twin_role_profile_mappings',
  'twin_health_actions', 'twin_health_automation_settings', 'twin_health_executor_ledger',
  'twin_health_followups', 'twin_health_outbox_deliveries', 'twin_health_plans',
  'twin_health_authorization_grants',
  'twin_health_action_reservations',
  'twin_home_spaces', 'twin_home_objects', 'twin_home_inventory_items', 'twin_home_inventory_ledger',
  'twin_home_devices', 'twin_home_device_bindings', 'twin_home_device_states',
  'twin_home_provider_events', 'twin_home_provider_cursors', 'twin_home_command_receipts',
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
    if (version < 6) {
      createSchemaV6(db)
      setSchemaVersion(db, 6)
    }
    if (version < 7) {
      createSchemaV7(db)
      setSchemaVersion(db, 7)
    }
    if (version < 8) {
      createSchemaV8(db)
      setSchemaVersion(db, 8)
    }
    if (version < 9) {
      createSchemaV9(db)
      setSchemaVersion(db, 9)
    }
    if (version < 10) {
      createSchemaV10(db)
      setSchemaVersion(db, 10)
    }
    if (version < 11) {
      createSchemaV11(db)
      setSchemaVersion(db, 11)
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
    ['consent_id', 'TEXT', 0, 1, null], ['manifest_digest', 'TEXT', 1, 0, null], ['processor', 'TEXT', 1, 0, null],
    ['scope_json', 'TEXT', 1, 0, null], ['issued_at', 'TEXT', 1, 0, null], ['expires_at', 'TEXT', 1, 0, null],
    ['consumed_at', 'TEXT', 0, 0, null], ['revoked_at', 'TEXT', 0, 0, null],
  ]
  if (!columnsMatch(consentColumns, expectedConsentColumns)) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: twin_artifact_consents signature is invalid`)
  }
  assertIndexSignature(db, version, 'twin_artifact_consents', 'idx_twin_artifact_consents_status',
    ['processor', 'expires_at', 'consumed_at', 'revoked_at'], false)
  assertIndexSignature(db, version, 'twin_artifact_consents', 'idx_twin_artifact_consents_manifest_digest',
    ['manifest_digest'], false)
  const reservationColumns = db.prepare("PRAGMA table_info('twin_artifact_consent_reservations')").all() as unknown as ColumnInfo[]
  const expectedReservationColumns: ColumnSignature[] = [
    ['reservation_id', 'TEXT', 0, 1, null], ['consent_id', 'TEXT', 1, 0, null],
    ['artifact_id', 'TEXT', 1, 0, null], ['artifact_manifest_digest', 'TEXT', 1, 0, null],
    ['processor', 'TEXT', 1, 0, null], ['reserved_at', 'TEXT', 1, 0, null],
    ['expires_at', 'TEXT', 1, 0, null], ['consumed_at', 'TEXT', 0, 0, null],
  ]
  if (!columnsMatch(reservationColumns, expectedReservationColumns)) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: consent reservation signature is invalid`)
  }
  const reservationSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
    AND name='twin_artifact_consent_reservations'`).get() as { sql: string } | undefined
  if (!reservationSql || canonicalSql(reservationSql.sql) !== canonicalSql(RESERVATION_TABLE_SQL)) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: consent reservation CREATE SQL signature is invalid`)
  }
  assertIndexSignature(db, version, 'twin_artifact_consent_reservations',
    'idx_twin_artifact_consent_reservations_status', ['processor', 'expires_at', 'consumed_at'], false)
  const reservationForeignKeys = db.prepare("PRAGMA foreign_key_list('twin_artifact_consent_reservations')").all() as Array<{
    table: string; from: string; to: string; on_update: string; on_delete: string; match: string
  }>
  if (reservationForeignKeys.length !== 1 || reservationForeignKeys[0].table !== 'twin_artifact_consents'
    || reservationForeignKeys[0].from !== 'consent_id' || reservationForeignKeys[0].to !== 'consent_id'
    || reservationForeignKeys[0].on_update !== 'NO ACTION' || reservationForeignKeys[0].on_delete !== 'NO ACTION'
    || reservationForeignKeys[0].match !== 'NONE') {
    throw new Error(`Personal Twin schema version ${version} is incomplete: consent reservation foreign key signature is invalid`)
  }
  assertHealthRuntimeSchema(db, version)
  assertHomeSchema(db, version)
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

function canonicalSql(value: string): string { return value.replace(/\s+/g, ' ').trim().toLowerCase() }

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

function assertConsentSchemaV5(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info('twin_artifact_consents')").all() as unknown as ColumnInfo[]
  const expected: ColumnSignature[] = [
    ['manifest_digest', 'TEXT', 0, 1, null], ['processor', 'TEXT', 1, 0, null],
    ['scope_json', 'TEXT', 1, 0, null], ['issued_at', 'TEXT', 1, 0, null], ['expires_at', 'TEXT', 1, 0, null],
    ['consumed_at', 'TEXT', 0, 0, null], ['revoked_at', 'TEXT', 0, 0, null],
  ]
  if (!columnsMatch(columns, expected)) throw new Error('Personal Twin v5 artifact consent signature is invalid')
  assertIndexSignature(db, 5, 'twin_artifact_consents', 'idx_twin_artifact_consents_status',
    ['processor', 'expires_at', 'consumed_at', 'revoked_at'], false)
}

function consentSchemaV6ColumnsMatch(db: DatabaseSync): boolean {
  const columns = db.prepare("PRAGMA table_info('twin_artifact_consents')").all() as unknown as ColumnInfo[]
  const expected: ColumnSignature[] = [
    ['consent_id', 'TEXT', 0, 1, null], ['manifest_digest', 'TEXT', 1, 0, null], ['processor', 'TEXT', 1, 0, null],
    ['scope_json', 'TEXT', 1, 0, null], ['issued_at', 'TEXT', 1, 0, null], ['expires_at', 'TEXT', 1, 0, null],
    ['consumed_at', 'TEXT', 0, 0, null], ['revoked_at', 'TEXT', 0, 0, null],
  ]
  return columnsMatch(columns, expected)
}

function createSchemaV6(db: DatabaseSync): void {
  if (consentSchemaV6ColumnsMatch(db)) {
    assertIndexSignature(db, 6, 'twin_artifact_consents', 'idx_twin_artifact_consents_status',
      ['processor', 'expires_at', 'consumed_at', 'revoked_at'], false)
    assertIndexSignature(db, 6, 'twin_artifact_consents', 'idx_twin_artifact_consents_manifest_digest',
      ['manifest_digest'], false)
    return
  }
  assertConsentSchemaV5(db)
  db.exec(`
    DROP INDEX idx_twin_artifact_consents_status;
    ALTER TABLE twin_artifact_consents RENAME TO twin_artifact_consents_v5;
    CREATE TABLE twin_artifact_consents (
      consent_id TEXT PRIMARY KEY
        CHECK(length(consent_id) BETWEEN 32 AND 80 AND consent_id NOT GLOB '*[^a-zA-Z0-9-]*'),
      manifest_digest TEXT NOT NULL
        CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
      processor TEXT NOT NULL,
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND length(CAST(scope_json AS BLOB)) <= 8192),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );
    INSERT INTO twin_artifact_consents
      (consent_id,manifest_digest,processor,scope_json,issued_at,expires_at,consumed_at,revoked_at)
      SELECT manifest_digest,manifest_digest,processor,scope_json,issued_at,expires_at,consumed_at,revoked_at
      FROM twin_artifact_consents_v5;
    DROP TABLE twin_artifact_consents_v5;
    CREATE INDEX idx_twin_artifact_consents_status
      ON twin_artifact_consents(processor, expires_at, consumed_at, revoked_at);
    CREATE INDEX idx_twin_artifact_consents_manifest_digest
      ON twin_artifact_consents(manifest_digest);
  `)
}

function createSchemaV7(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS twin_artifact_consent_reservations;
    ${RESERVATION_TABLE_SQL};
    CREATE INDEX IF NOT EXISTS idx_twin_artifact_consent_reservations_status
      ON twin_artifact_consent_reservations(processor,expires_at,consumed_at);
  `)
  probeReservationChecks(db)
}

function createSchemaV8(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_health_automation_settings (
      subject_id TEXT PRIMARY KEY REFERENCES twin_entities(id),
      live_delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(live_delivery_enabled IN (0,1)),
      profile TEXT NOT NULL CHECK(length(profile) BETWEEN 1 AND 100),
      recipient TEXT NOT NULL CHECK(recipient='configured-self'),
      configured_connectors_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(configured_connectors_json) AND json_type(configured_connectors_json)='array'
          AND length(CAST(configured_connectors_json AS BLOB)) <= 4096),
      configured_processors_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(configured_processors_json) AND json_type(configured_processors_json)='array'
          AND length(CAST(configured_processors_json AS BLOB)) <= 4096),
      version INTEGER NOT NULL CHECK(version >= 1),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) BETWEEN 1 AND 160),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twin_health_outbox_deliveries (
      consumer_id TEXT NOT NULL CHECK(length(consumer_id) BETWEEN 1 AND 100),
      outbox_id TEXT NOT NULL REFERENCES twin_outbox(id),
      status TEXT NOT NULL CHECK(status IN ('leased','completed','dead_letter')),
      attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 16),
      lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 100),
      lease_until TEXT,
      last_error_code TEXT CHECK(last_error_code IS NULL OR (length(last_error_code) BETWEEN 2 AND 128
        AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
      intent_id TEXT,
      workflow_id TEXT,
      completed_at TEXT,
      PRIMARY KEY(consumer_id,outbox_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_health_outbox_delivery_claim
      ON twin_health_outbox_deliveries(consumer_id,status,lease_until);
    CREATE TABLE IF NOT EXISTS twin_health_actions (
      action_id TEXT PRIMARY KEY CHECK(length(action_id) BETWEEN 1 AND 160),
      intervention_id TEXT NOT NULL CHECK(length(intervention_id) BETWEEN 1 AND 160),
      workflow_id TEXT NOT NULL UNIQUE CHECK(length(workflow_id) BETWEEN 1 AND 200),
      user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 160),
      capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 1 AND 160),
      category TEXT NOT NULL CHECK(category IN ('training','recovery','nutrition','posture','skin','internal_health')),
      priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 10000),
      supersedable INTEGER NOT NULL CHECK(supersedable IN (0,1)),
      risk TEXT NOT NULL CHECK(risk IN ('none','low','medium','high','critical')),
      authority TEXT NOT NULL CHECK(authority IN ('auto','approval','inform_only')),
      source_outbox_id TEXT NOT NULL REFERENCES twin_outbox(id),
      effective_date TEXT NOT NULL CHECK(length(effective_date)=10),
      status TEXT NOT NULL CHECK(status IN ('active','superseded','completed')),
      created_at TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_twin_health_actions_active
      ON twin_health_actions(user_id,status,priority DESC,created_at);
    CREATE TABLE IF NOT EXISTS twin_health_plans (
      plan_id TEXT PRIMARY KEY CHECK(length(plan_id) BETWEEN 1 AND 160),
      version INTEGER NOT NULL CHECK(version >= 1),
      digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
      state_json TEXT NOT NULL CHECK(json_valid(state_json) AND json_type(state_json)='object'
        AND length(CAST(state_json AS BLOB)) <= 65536),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS twin_health_followups (
      followup_id TEXT PRIMARY KEY CHECK(length(followup_id) BETWEEN 1 AND 160),
      owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 160),
      category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 80),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 100),
      reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 100),
      due_at TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('scheduled','superseded'))
    );
    CREATE TABLE IF NOT EXISTS twin_health_executor_ledger (
      execution_token TEXT PRIMARY KEY CHECK(length(execution_token) BETWEEN 1 AND 200),
      material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
      kind TEXT NOT NULL CHECK(kind IN ('source','plan','followup','analysis')),
      result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'
        AND length(CAST(result_json AS BLOB)) <= 524288),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twin_health_executor_ledger_kind ON twin_health_executor_ledger(kind,created_at);
    CREATE TRIGGER IF NOT EXISTS twin_health_delivery_terminal_immutable
      BEFORE UPDATE ON twin_health_outbox_deliveries
      WHEN OLD.status IN ('completed','dead_letter') BEGIN SELECT RAISE(ABORT,'HEALTH_DELIVERY_TERMINAL'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_delivery_no_delete
      BEFORE DELETE ON twin_health_outbox_deliveries BEGIN SELECT RAISE(ABORT,'HEALTH_DELIVERY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_ledger_no_update
      BEFORE UPDATE ON twin_health_executor_ledger BEGIN SELECT RAISE(ABORT,'HEALTH_LEDGER_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_ledger_no_delete
      BEFORE DELETE ON twin_health_executor_ledger BEGIN SELECT RAISE(ABORT,'HEALTH_LEDGER_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_action_identity_immutable
      BEFORE UPDATE ON twin_health_actions WHEN NEW.action_id != OLD.action_id OR NEW.intervention_id != OLD.intervention_id
        OR NEW.workflow_id != OLD.workflow_id OR NEW.user_id != OLD.user_id OR NEW.capability_id != OLD.capability_id
        OR NEW.category != OLD.category OR NEW.supersedable != OLD.supersedable
        OR NEW.source_outbox_id != OLD.source_outbox_id OR NEW.effective_date != OLD.effective_date
      BEGIN SELECT RAISE(ABORT,'HEALTH_ACTION_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_action_no_delete
      BEFORE DELETE ON twin_health_actions BEGIN SELECT RAISE(ABORT,'HEALTH_ACTION_IMMUTABLE'); END;
  `)
}

function createSchemaV9(db:DatabaseSync):void {
  addColumnIfMissing(db,'twin_health_outbox_deliveries','prepared_json',`TEXT CHECK(prepared_json IS NULL OR
    (json_valid(prepared_json) AND json_type(prepared_json)='object' AND length(CAST(prepared_json AS BLOB)) <= 1048576))`)
  addColumnIfMissing(db,'twin_health_outbox_deliveries','prepared_digest',`TEXT CHECK(prepared_digest IS NULL OR
    (length(prepared_digest)=64 AND prepared_digest NOT GLOB '*[^a-f0-9]*'))`)
  addColumnIfMissing(db,'twin_health_outbox_deliveries','prepared_at','TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_health_authorization_grants (
      request_digest TEXT PRIMARY KEY CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
      settings_version INTEGER NOT NULL CHECK(settings_version >= 1),
      grant_json TEXT NOT NULL CHECK(json_valid(grant_json) AND json_type(grant_json)='object'
        AND length(CAST(grant_json AS BLOB)) <= 8192),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS twin_health_delivery_prepared_shape
      BEFORE UPDATE ON twin_health_outbox_deliveries WHEN
        (NEW.prepared_json IS NULL) != (NEW.prepared_digest IS NULL)
        OR (NEW.prepared_json IS NULL) != (NEW.prepared_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'HEALTH_PREPARED_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_delivery_prepared_immutable
      BEFORE UPDATE ON twin_health_outbox_deliveries WHEN OLD.prepared_json IS NOT NULL AND
        (NEW.prepared_json IS NOT OLD.prepared_json OR NEW.prepared_digest IS NOT OLD.prepared_digest
          OR NEW.prepared_at IS NOT OLD.prepared_at)
      BEGIN SELECT RAISE(ABORT,'HEALTH_PREPARED_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_auth_grant_no_update
      BEFORE UPDATE ON twin_health_authorization_grants BEGIN SELECT RAISE(ABORT,'HEALTH_AUTH_GRANT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_health_auth_grant_no_delete
      BEFORE DELETE ON twin_health_authorization_grants BEGIN SELECT RAISE(ABORT,'HEALTH_AUTH_GRANT_IMMUTABLE'); END;
  `)
}

function addColumnIfMissing(db:DatabaseSync,table:string,column:string,declaration:string):void {
  const columns=db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{name:string}>
  if(!columns.some(item=>item.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

function createSchemaV10(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS twin_health_action_reservations (
    action_id TEXT PRIMARY KEY CHECK(length(action_id) BETWEEN 1 AND 160),
    material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
    intervention_id TEXT NOT NULL CHECK(length(intervention_id) BETWEEN 1 AND 160),
    user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 160),
    capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 1 AND 160),
    category TEXT NOT NULL CHECK(category IN ('training','recovery','nutrition','posture','skin','internal_health')),
    priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 10000),
    supersedable INTEGER NOT NULL CHECK(supersedable IN (0,1)),
    risk TEXT NOT NULL CHECK(risk IN ('none','low','medium','high','critical')),
    authority TEXT NOT NULL CHECK(authority IN ('auto','approval','inform_only')),
    supersedes_json TEXT NOT NULL CHECK(json_valid(supersedes_json) AND json_type(supersedes_json)='array'
      AND length(CAST(supersedes_json AS BLOB)) <= 65536),
    source_outbox_id TEXT NOT NULL REFERENCES twin_outbox(id),
    effective_date TEXT NOT NULL CHECK(length(effective_date)=10),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','finalized')),
    intent_id TEXT,
    workflow_id TEXT UNIQUE,
    finalized_at TEXT,
    CHECK((status='reserved' AND intent_id IS NULL AND workflow_id IS NULL AND finalized_at IS NULL)
      OR (status='finalized' AND intent_id IS NOT NULL AND workflow_id IS NOT NULL AND finalized_at IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS twin_health_action_reservation_material_immutable BEFORE UPDATE
    ON twin_health_action_reservations WHEN NEW.action_id IS NOT OLD.action_id
      OR NEW.material_digest IS NOT OLD.material_digest OR NEW.intervention_id IS NOT OLD.intervention_id
      OR NEW.user_id IS NOT OLD.user_id OR NEW.capability_id IS NOT OLD.capability_id
      OR NEW.category IS NOT OLD.category OR NEW.priority IS NOT OLD.priority
      OR NEW.supersedable IS NOT OLD.supersedable OR NEW.risk IS NOT OLD.risk OR NEW.authority IS NOT OLD.authority
      OR NEW.supersedes_json IS NOT OLD.supersedes_json OR NEW.source_outbox_id IS NOT OLD.source_outbox_id
      OR NEW.effective_date IS NOT OLD.effective_date OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'HEALTH_ACTION_RESERVATION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS twin_health_action_reservation_no_delete BEFORE DELETE
    ON twin_health_action_reservations BEGIN SELECT RAISE(ABORT,'HEALTH_ACTION_RESERVATION_IMMUTABLE'); END;`)
}

function createSchemaV11(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_home_spaces (
      space_id TEXT PRIMARY KEY CHECK(length(space_id) BETWEEN 1 AND 160
        AND space_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      kind TEXT NOT NULL CHECK(kind IN ('home','floor','room','zone','furniture','compartment','surface')),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      parent_space_id TEXT REFERENCES twin_home_spaces(space_id),
      attributes_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(attributes_json) AND json_type(attributes_json)='object'
          AND length(CAST(attributes_json AS BLOB)) <= 65536),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(parent_space_id IS NULL OR parent_space_id != space_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_home_spaces_parent ON twin_home_spaces(parent_space_id,kind,name);

    CREATE TABLE IF NOT EXISTS twin_home_objects (
      object_id TEXT PRIMARY KEY CHECK(length(object_id) BETWEEN 1 AND 160
        AND object_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80 AND kind NOT GLOB '*[^a-z0-9._-]*'),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      space_id TEXT REFERENCES twin_home_spaces(space_id),
      attributes_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(attributes_json) AND json_type(attributes_json)='object'
          AND length(CAST(attributes_json AS BLOB)) <= 65536),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twin_home_objects_space ON twin_home_objects(space_id,kind,name);

    CREATE TABLE IF NOT EXISTS twin_home_inventory_items (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) BETWEEN 1 AND 160
        AND item_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 40 AND unit NOT GLOB '*[^a-zA-Z0-9._/-]*'),
      quantity REAL NOT NULL CHECK(quantity >= 0),
      low_stock_threshold REAL CHECK(low_stock_threshold IS NULL OR low_stock_threshold >= 0),
      attributes_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(attributes_json) AND json_type(attributes_json)='object'
          AND length(CAST(attributes_json AS BLOB)) <= 65536),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_home_inventory_ledger (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 160
        AND entry_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      item_id TEXT NOT NULL REFERENCES twin_home_inventory_items(item_id),
      delta REAL NOT NULL CHECK(delta != 0),
      resulting_quantity REAL NOT NULL CHECK(resulting_quantity >= 0),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 100 AND source NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 255),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_home_inventory_ledger_source
      ON twin_home_inventory_ledger(source,source_id);
    CREATE INDEX IF NOT EXISTS idx_twin_home_inventory_ledger_item
      ON twin_home_inventory_ledger(item_id,created_at);

    CREATE TABLE IF NOT EXISTS twin_home_devices (
      device_id TEXT PRIMARY KEY CHECK(length(device_id) BETWEEN 1 AND 160
        AND device_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      device_class TEXT NOT NULL CHECK(length(device_class) BETWEEN 1 AND 80
        AND device_class NOT GLOB '*[^a-z0-9._-]*'),
      space_id TEXT REFERENCES twin_home_spaces(space_id),
      availability TEXT NOT NULL CHECK(availability IN ('available','unavailable','unknown')),
      attributes_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(attributes_json) AND json_type(attributes_json)='object'
          AND length(CAST(attributes_json AS BLOB)) <= 65536),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_twin_home_devices_space ON twin_home_devices(space_id,device_class,name);

    CREATE TABLE IF NOT EXISTS twin_home_device_bindings (
      binding_id TEXT PRIMARY KEY CHECK(length(binding_id) BETWEEN 1 AND 160
        AND binding_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      device_id TEXT NOT NULL REFERENCES twin_home_devices(device_id),
      provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80 AND provider NOT GLOB '*[^a-z0-9-]*'),
      external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 255),
      capabilities_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(capabilities_json) AND json_type(capabilities_json)='array'
          AND length(CAST(capabilities_json AS BLOB)) <= 16384),
      metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'
          AND length(CAST(metadata_json AS BLOB)) <= 65536),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_home_binding_provider_identity
      ON twin_home_device_bindings(provider,external_id);
    CREATE INDEX IF NOT EXISTS idx_twin_home_bindings_device
      ON twin_home_device_bindings(device_id,provider);

    CREATE TABLE IF NOT EXISTS twin_home_provider_events (
      provider_event_id TEXT PRIMARY KEY CHECK(length(provider_event_id) BETWEEN 1 AND 200
        AND provider_event_id NOT GLOB '*[^a-zA-Z0-9:._-]*'),
      provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80 AND provider NOT GLOB '*[^a-z0-9-]*'),
      event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 255),
      event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100
        AND event_type NOT GLOB '*[^a-z0-9._-]*'),
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'
        AND length(CAST(payload_json AS BLOB)) <= 524288),
      status TEXT NOT NULL CHECK(status IN ('received','applied','ignored','rejected')),
      error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128
        AND error_code NOT GLOB '*[^A-Z0-9_]*'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_home_provider_event_identity
      ON twin_home_provider_events(provider,event_id);
    CREATE INDEX IF NOT EXISTS idx_twin_home_provider_events_occurred
      ON twin_home_provider_events(provider,occurred_at,provider_event_id);

    CREATE TABLE IF NOT EXISTS twin_home_device_states (
      device_id TEXT NOT NULL REFERENCES twin_home_devices(device_id),
      state_key TEXT NOT NULL CHECK(length(state_key) BETWEEN 1 AND 100
        AND state_key NOT GLOB '*[^a-z0-9._-]*'),
      value_json TEXT NOT NULL CHECK(json_valid(value_json)
        AND length(CAST(value_json AS BLOB)) <= 65536),
      source_event_id TEXT NOT NULL REFERENCES twin_home_provider_events(provider_event_id),
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 1),
      PRIMARY KEY(device_id,state_key)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_home_device_states_observed
      ON twin_home_device_states(observed_at,device_id);

    CREATE TABLE IF NOT EXISTS twin_home_provider_cursors (
      provider TEXT PRIMARY KEY CHECK(length(provider) BETWEEN 1 AND 80 AND provider NOT GLOB '*[^a-z0-9-]*'),
      cursor_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(cursor_json) AND json_type(cursor_json)='object'
          AND length(CAST(cursor_json AS BLOB)) <= 16384),
      connection_status TEXT NOT NULL CHECK(connection_status IN ('disconnected','connecting','connected','degraded')),
      last_event_at TEXT,
      version INTEGER NOT NULL CHECK(version >= 1),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_home_command_receipts (
      execution_token TEXT PRIMARY KEY CHECK(length(execution_token) BETWEEN 1 AND 200),
      material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
      provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80 AND provider NOT GLOB '*[^a-z0-9-]*'),
      external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 255),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 100 AND operation NOT GLOB '*[^a-z0-9._-]*'),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'
        AND length(CAST(request_json AS BLOB)) <= 65536),
      expected_state_json TEXT NOT NULL CHECK(json_valid(expected_state_json) AND json_type(expected_state_json)='object'
        AND length(CAST(expected_state_json AS BLOB)) <= 65536),
      provider_request_id TEXT CHECK(provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 255),
      status TEXT NOT NULL CHECK(status IN ('prepared','sent','verified','unknown','failed')),
      observed_event_id TEXT REFERENCES twin_home_provider_events(provider_event_id),
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object'
        AND length(CAST(result_json AS BLOB)) <= 65536)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      CHECK(status != 'verified' OR (observed_event_id IS NOT NULL AND verified_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_twin_home_command_receipts_status
      ON twin_home_command_receipts(provider,status,updated_at);

    CREATE TRIGGER IF NOT EXISTS twin_home_inventory_ledger_no_update BEFORE UPDATE
      ON twin_home_inventory_ledger BEGIN SELECT RAISE(ABORT,'HOME_INVENTORY_LEDGER_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_home_inventory_ledger_no_delete BEFORE DELETE
      ON twin_home_inventory_ledger BEGIN SELECT RAISE(ABORT,'HOME_INVENTORY_LEDGER_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_home_provider_event_no_update BEFORE UPDATE
      ON twin_home_provider_events BEGIN SELECT RAISE(ABORT,'HOME_PROVIDER_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_home_provider_event_no_delete BEFORE DELETE
      ON twin_home_provider_events BEGIN SELECT RAISE(ABORT,'HOME_PROVIDER_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_home_command_receipt_identity_immutable BEFORE UPDATE
      ON twin_home_command_receipts WHEN NEW.execution_token IS NOT OLD.execution_token
        OR NEW.material_digest IS NOT OLD.material_digest OR NEW.provider IS NOT OLD.provider
        OR NEW.external_id IS NOT OLD.external_id OR NEW.operation IS NOT OLD.operation
        OR NEW.request_json IS NOT OLD.request_json OR NEW.expected_state_json IS NOT OLD.expected_state_json
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'HOME_COMMAND_RECEIPT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS twin_home_command_receipt_no_delete BEFORE DELETE
      ON twin_home_command_receipts BEGIN SELECT RAISE(ABORT,'HOME_COMMAND_RECEIPT_IMMUTABLE'); END;
  `)
}

function assertHealthRuntimeSchema(db: DatabaseSync, version: number): void {
  const expected: Array<[string, ColumnSignature[]]> = [
    ['twin_health_automation_settings', [
      ['subject_id','TEXT',0,1,null], ['live_delivery_enabled','INTEGER',1,0,'0'], ['profile','TEXT',1,0,null],
      ['recipient','TEXT',1,0,null], ['configured_connectors_json','TEXT',1,0,"'[]'"],
      ['configured_processors_json','TEXT',1,0,"'[]'"], ['version','INTEGER',1,0,null],
      ['actor_user_id','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_health_outbox_deliveries', [
      ['consumer_id','TEXT',1,1,null], ['outbox_id','TEXT',1,2,null], ['status','TEXT',1,0,null],
      ['attempts','INTEGER',1,0,null], ['lease_owner','TEXT',0,0,null], ['lease_until','TEXT',0,0,null],
      ['last_error_code','TEXT',0,0,null], ['intent_id','TEXT',0,0,null], ['workflow_id','TEXT',0,0,null],
      ['completed_at','TEXT',0,0,null],
      ['prepared_json','TEXT',0,0,null], ['prepared_digest','TEXT',0,0,null], ['prepared_at','TEXT',0,0,null],
    ]],
    ['twin_health_actions', [
      ['action_id','TEXT',0,1,null], ['intervention_id','TEXT',1,0,null], ['workflow_id','TEXT',1,0,null],
      ['user_id','TEXT',1,0,null], ['capability_id','TEXT',1,0,null], ['category','TEXT',1,0,null],
      ['priority','INTEGER',1,0,null], ['supersedable','INTEGER',1,0,null],
      ['risk','TEXT',1,0,null], ['authority','TEXT',1,0,null], ['source_outbox_id','TEXT',1,0,null],
      ['effective_date','TEXT',1,0,null], ['status','TEXT',1,0,null], ['created_at','TEXT',1,0,null],
      ['superseded_at','TEXT',0,0,null],
    ]],
    ['twin_health_plans', [
      ['plan_id','TEXT',0,1,null], ['version','INTEGER',1,0,null], ['digest','TEXT',1,0,null],
      ['state_json','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_health_followups', [
      ['followup_id','TEXT',0,1,null], ['owner_user_id','TEXT',1,0,null], ['category','TEXT',1,0,null],
      ['operation','TEXT',1,0,null], ['reason_code','TEXT',1,0,null], ['due_at','TEXT',1,0,null],
      ['scheduled_at','TEXT',1,0,null], ['status','TEXT',1,0,null],
    ]],
    ['twin_health_executor_ledger', [
      ['execution_token','TEXT',0,1,null], ['material_digest','TEXT',1,0,null], ['kind','TEXT',1,0,null],
      ['result_json','TEXT',1,0,null], ['created_at','TEXT',1,0,null],
    ]],
    ['twin_health_authorization_grants', [
      ['request_digest','TEXT',0,1,null], ['evidence_digest','TEXT',1,0,null],
      ['settings_version','INTEGER',1,0,null], ['grant_json','TEXT',1,0,null],
      ['issued_at','TEXT',1,0,null], ['expires_at','TEXT',1,0,null],
    ]],
    ['twin_health_action_reservations', [
      ['action_id','TEXT',0,1,null], ['material_digest','TEXT',1,0,null], ['intervention_id','TEXT',1,0,null],
      ['user_id','TEXT',1,0,null], ['capability_id','TEXT',1,0,null], ['category','TEXT',1,0,null],
      ['priority','INTEGER',1,0,null], ['supersedable','INTEGER',1,0,null], ['risk','TEXT',1,0,null],
      ['authority','TEXT',1,0,null], ['supersedes_json','TEXT',1,0,null], ['source_outbox_id','TEXT',1,0,null],
      ['effective_date','TEXT',1,0,null], ['created_at','TEXT',1,0,null], ['status','TEXT',1,0,null],
      ['intent_id','TEXT',0,0,null], ['workflow_id','TEXT',0,0,null], ['finalized_at','TEXT',0,0,null],
    ]],
  ]
  for (const [table, columns] of expected) {
    const actual = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as ColumnInfo[]
    if (!columnsMatch(actual, columns)) throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} signature is invalid`)
  }
  const requiredSql:Record<string,string[]>={
    twin_health_automation_settings:["check(live_delivery_enabled in (0,1))","check(recipient='configured-self')",
      "check(json_valid(configured_connectors_json) and json_type(configured_connectors_json)='array' and length(cast(configured_connectors_json as blob)) <= 4096)",
      "check(json_valid(configured_processors_json) and json_type(configured_processors_json)='array' and length(cast(configured_processors_json as blob)) <= 4096)",
      'check(version >= 1)'],
    twin_health_outbox_deliveries:["check(status in ('leased','completed','dead_letter'))",
      'check(attempts between 1 and 16)',"last_error_code not glob '*[^a-z0-9_]*'",
      "json_valid(prepared_json)","length(cast(prepared_json as blob)) <= 1048576"],
    twin_health_actions:["check(category in ('training','recovery','nutrition','posture','skin','internal_health'))",
      'check(priority between 0 and 10000)','check(supersedable in (0,1))',
      "check(risk in ('none','low','medium','high','critical'))","check(authority in ('auto','approval','inform_only'))",
      "check(status in ('active','superseded','completed'))"],
    twin_health_plans:['check(version >= 1)',"check(length(digest)=64 and digest not glob '*[^a-f0-9]*')",
      "check(json_valid(state_json) and json_type(state_json)='object' and length(cast(state_json as blob)) <= 65536)"],
    twin_health_followups:["check(status in ('scheduled','superseded'))"],
    twin_health_executor_ledger:["check(kind in ('source','plan','followup','analysis'))",
      "check(json_valid(result_json) and json_type(result_json)='object' and length(cast(result_json as blob)) <= 524288)"],
    twin_health_authorization_grants:["check(length(request_digest)=64 and request_digest not glob '*[^a-f0-9]*')",
      'check(settings_version >= 1)',"check(json_valid(grant_json) and json_type(grant_json)='object' and length(cast(grant_json as blob)) <= 8192)"],
    twin_health_action_reservations:["check(status in ('reserved','finalized'))",
      "check((status='reserved' and intent_id is null and workflow_id is null and finalized_at is null) or (status='finalized' and intent_id is not null and workflow_id is not null and finalized_at is not null))",
      "check(json_valid(supersedes_json) and json_type(supersedes_json)='array' and length(cast(supersedes_json as blob)) <= 65536)"],
  }
  for(const [table,fragments] of Object.entries(requiredSql)){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}|undefined
    const sql=canonicalSql(row?.sql??'')
    if(fragments.some(fragment=>!sql.includes(canonicalSql(fragment)))) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} CHECK signature is invalid`)
    }
  }
  assertIndexSignature(db, version, 'twin_health_outbox_deliveries', 'idx_twin_health_outbox_delivery_claim',
    ['consumer_id','status','lease_until'], false)
  assertIndexSignature(db, version, 'twin_health_actions', 'idx_twin_health_actions_active',
    ['user_id','status','priority','created_at'], false)
  assertIndexSignature(db, version, 'twin_health_executor_ledger', 'idx_twin_health_executor_ledger_kind',
    ['kind','created_at'], false)
  const foreignKeys = db.prepare("PRAGMA foreign_key_list('twin_health_outbox_deliveries')").all() as Array<{
    table:string; from:string; to:string; on_update:string; on_delete:string
  }>
  if (foreignKeys.length !== 1 || foreignKeys[0].table !== 'twin_outbox' || foreignKeys[0].from !== 'outbox_id'
    || foreignKeys[0].to !== 'id' || foreignKeys[0].on_update !== 'NO ACTION' || foreignKeys[0].on_delete !== 'NO ACTION') {
    throw new Error(`Personal Twin schema version ${version} is incomplete: health delivery foreign key is invalid`)
  }
  const actionForeignKeys=db.prepare("PRAGMA foreign_key_list('twin_health_actions')").all() as Array<{
    table:string;from:string;to:string;on_update:string;on_delete:string}>
  const settingsForeignKeys=db.prepare("PRAGMA foreign_key_list('twin_health_automation_settings')").all() as Array<{
    table:string;from:string;to:string;on_update:string;on_delete:string}>
  if(actionForeignKeys.length!==1||actionForeignKeys[0].table!=='twin_outbox'||actionForeignKeys[0].from!=='source_outbox_id'
    ||actionForeignKeys[0].to!=='id'||actionForeignKeys[0].on_update!=='NO ACTION'||actionForeignKeys[0].on_delete!=='NO ACTION'
    ||settingsForeignKeys.length!==1||settingsForeignKeys[0].table!=='twin_entities'||settingsForeignKeys[0].from!=='subject_id'
    ||settingsForeignKeys[0].to!=='id'||settingsForeignKeys[0].on_update!=='NO ACTION'||settingsForeignKeys[0].on_delete!=='NO ACTION') {
    throw new Error(`Personal Twin schema version ${version} is incomplete: health runtime foreign key signature is invalid`)
  }
  const requiredTriggers = ['twin_health_action_identity_immutable','twin_health_action_no_delete',
    'twin_health_delivery_no_delete','twin_health_delivery_terminal_immutable',
    'twin_health_ledger_no_delete','twin_health_ledger_no_update','twin_health_delivery_prepared_shape',
    'twin_health_delivery_prepared_immutable','twin_health_auth_grant_no_update','twin_health_auth_grant_no_delete']
  requiredTriggers.push('twin_health_action_reservation_material_immutable','twin_health_action_reservation_no_delete')
  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{name:string}>).map(row => row.name))
  if (requiredTriggers.some(name => !triggers.has(name))) {
    throw new Error(`Personal Twin schema version ${version} is incomplete: health runtime triggers are invalid`)
  }
  const triggerFragments:Record<string,string[]>={
    twin_health_delivery_terminal_immutable:["old.status in ('completed','dead_letter')","raise(abort,'health_delivery_terminal')"],
    twin_health_delivery_no_delete:["before delete on twin_health_outbox_deliveries","raise(abort,'health_delivery_immutable')"],
    twin_health_ledger_no_update:["before update on twin_health_executor_ledger","raise(abort,'health_ledger_immutable')"],
    twin_health_ledger_no_delete:["before delete on twin_health_executor_ledger","raise(abort,'health_ledger_immutable')"],
    twin_health_action_identity_immutable:['new.category != old.category','new.supersedable != old.supersedable',
      "raise(abort,'health_action_identity_immutable')"],
    twin_health_action_no_delete:["before delete on twin_health_actions","raise(abort,'health_action_immutable')"],
    twin_health_delivery_prepared_shape:['new.prepared_json is null','new.prepared_digest is null',"raise(abort,'health_prepared_shape')"],
    twin_health_delivery_prepared_immutable:['old.prepared_json is not null',"raise(abort,'health_prepared_immutable')"],
    twin_health_auth_grant_no_update:['before update on twin_health_authorization_grants',"raise(abort,'health_auth_grant_immutable')"],
    twin_health_auth_grant_no_delete:['before delete on twin_health_authorization_grants',"raise(abort,'health_auth_grant_immutable')"],
    twin_health_action_reservation_material_immutable:['new.material_digest is not old.material_digest',
      "raise(abort,'health_action_reservation_immutable')"],
    twin_health_action_reservation_no_delete:['before delete on twin_health_action_reservations',
      "raise(abort,'health_action_reservation_immutable')"],
  }
  for(const [name,fragments] of Object.entries(triggerFragments)){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}|undefined
    const sql=canonicalSql(row?.sql??'')
    if(fragments.some(fragment=>!sql.includes(canonicalSql(fragment)))) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: health runtime trigger signature is invalid`)
    }
  }
}

function assertHomeSchema(db: DatabaseSync, version: number): void {
  const expected: Array<[string, ColumnSignature[]]> = [
    ['twin_home_spaces', [
      ['space_id','TEXT',0,1,null], ['kind','TEXT',1,0,null], ['name','TEXT',1,0,null],
      ['parent_space_id','TEXT',0,0,null], ['attributes_json','TEXT',1,0,"'{}'"], ['version','INTEGER',1,0,null],
      ['created_at','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_objects', [
      ['object_id','TEXT',0,1,null], ['kind','TEXT',1,0,null], ['name','TEXT',1,0,null],
      ['space_id','TEXT',0,0,null], ['attributes_json','TEXT',1,0,"'{}'"], ['version','INTEGER',1,0,null],
      ['created_at','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_inventory_items', [
      ['item_id','TEXT',0,1,null], ['name','TEXT',1,0,null], ['unit','TEXT',1,0,null], ['quantity','REAL',1,0,null],
      ['low_stock_threshold','REAL',0,0,null], ['attributes_json','TEXT',1,0,"'{}'"], ['version','INTEGER',1,0,null],
      ['created_at','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_inventory_ledger', [
      ['entry_id','TEXT',0,1,null], ['item_id','TEXT',1,0,null], ['delta','REAL',1,0,null],
      ['resulting_quantity','REAL',1,0,null], ['reason','TEXT',1,0,null], ['source','TEXT',1,0,null],
      ['source_id','TEXT',1,0,null], ['created_at','TEXT',1,0,null],
    ]],
    ['twin_home_devices', [
      ['device_id','TEXT',0,1,null], ['name','TEXT',1,0,null], ['device_class','TEXT',1,0,null],
      ['space_id','TEXT',0,0,null], ['availability','TEXT',1,0,null], ['attributes_json','TEXT',1,0,"'{}'"],
      ['version','INTEGER',1,0,null], ['created_at','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_device_bindings', [
      ['binding_id','TEXT',0,1,null], ['device_id','TEXT',1,0,null], ['provider','TEXT',1,0,null],
      ['external_id','TEXT',1,0,null], ['capabilities_json','TEXT',1,0,"'[]'"], ['metadata_json','TEXT',1,0,"'{}'"],
      ['version','INTEGER',1,0,null], ['created_at','TEXT',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_provider_events', [
      ['provider_event_id','TEXT',0,1,null], ['provider','TEXT',1,0,null], ['event_id','TEXT',1,0,null],
      ['event_type','TEXT',1,0,null], ['occurred_at','TEXT',1,0,null], ['received_at','TEXT',1,0,null],
      ['payload_json','TEXT',1,0,null], ['status','TEXT',1,0,null], ['error_code','TEXT',0,0,null],
    ]],
    ['twin_home_device_states', [
      ['device_id','TEXT',1,1,null], ['state_key','TEXT',1,2,null], ['value_json','TEXT',1,0,null],
      ['source_event_id','TEXT',1,0,null], ['observed_at','TEXT',1,0,null], ['received_at','TEXT',1,0,null],
      ['version','INTEGER',1,0,null],
    ]],
    ['twin_home_provider_cursors', [
      ['provider','TEXT',0,1,null], ['cursor_json','TEXT',1,0,"'{}'"], ['connection_status','TEXT',1,0,null],
      ['last_event_at','TEXT',0,0,null], ['version','INTEGER',1,0,null], ['updated_at','TEXT',1,0,null],
    ]],
    ['twin_home_command_receipts', [
      ['execution_token','TEXT',0,1,null], ['material_digest','TEXT',1,0,null], ['provider','TEXT',1,0,null],
      ['external_id','TEXT',1,0,null], ['operation','TEXT',1,0,null], ['request_json','TEXT',1,0,null],
      ['expected_state_json','TEXT',1,0,null], ['provider_request_id','TEXT',0,0,null], ['status','TEXT',1,0,null],
      ['observed_event_id','TEXT',0,0,null], ['result_json','TEXT',0,0,null], ['created_at','TEXT',1,0,null],
      ['updated_at','TEXT',1,0,null], ['verified_at','TEXT',0,0,null],
    ]],
  ]
  for (const [table, columns] of expected) {
    const actual = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as ColumnInfo[]
    if (!columnsMatch(actual, columns)) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} signature is invalid`)
    }
  }

  const requiredSql: Record<string, string[]> = {
    twin_home_spaces: ["check(kind in ('home','floor','room','zone','furniture','compartment','surface'))",
      "json_type(attributes_json)='object'", 'length(cast(attributes_json as blob)) <= 65536',
      'check(version >= 1)', 'check(parent_space_id is null or parent_space_id != space_id)'],
    twin_home_objects: ["kind not glob '*[^a-z0-9._-]*'", "json_type(attributes_json)='object'", 'check(version >= 1)'],
    twin_home_inventory_items: ['check(quantity >= 0)', 'check(low_stock_threshold is null or low_stock_threshold >= 0)',
      "json_type(attributes_json)='object'", 'check(version >= 1)'],
    twin_home_inventory_ledger: ['check(delta != 0)', 'check(resulting_quantity >= 0)',
      "source not glob '*[^a-za-z0-9:._-]*'"],
    twin_home_devices: ["check(availability in ('available','unavailable','unknown'))",
      "device_class not glob '*[^a-z0-9._-]*'", "json_type(attributes_json)='object'", 'check(version >= 1)'],
    twin_home_device_bindings: ["provider not glob '*[^a-z0-9-]*'", "json_type(capabilities_json)='array'",
      'length(cast(capabilities_json as blob)) <= 16384', "json_type(metadata_json)='object'", 'check(version >= 1)'],
    twin_home_provider_events: ["provider not glob '*[^a-z0-9-]*'", "event_type not glob '*[^a-z0-9._-]*'",
      "json_type(payload_json)='object'", 'length(cast(payload_json as blob)) <= 524288',
      "check(status in ('received','applied','ignored','rejected'))", "error_code not glob '*[^a-z0-9_]*'"],
    twin_home_device_states: ["state_key not glob '*[^a-z0-9._-]*'", 'check(json_valid(value_json)',
      'length(cast(value_json as blob)) <= 65536', 'check(version >= 1)'],
    twin_home_provider_cursors: ["provider not glob '*[^a-z0-9-]*'", "json_type(cursor_json)='object'",
      'length(cast(cursor_json as blob)) <= 16384',
      "check(connection_status in ('disconnected','connecting','connected','degraded'))", 'check(version >= 1)'],
    twin_home_command_receipts: ["check(length(material_digest)=64 and material_digest not glob '*[^a-f0-9]*')",
      "provider not glob '*[^a-z0-9-]*'", "operation not glob '*[^a-z0-9._-]*'", "json_type(request_json)='object'",
      "json_type(expected_state_json)='object'", "check(status in ('prepared','sent','verified','unknown','failed'))",
      "check(status != 'verified' or (observed_event_id is not null and verified_at is not null))"],
  }
  for (const [table, fragments] of Object.entries(requiredSql)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined
    const sql = canonicalSql(row?.sql ?? '')
    if (fragments.some(fragment => !sql.includes(canonicalSql(fragment)))) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} CHECK signature is invalid`)
    }
  }

  assertIndexSignature(db, version, 'twin_home_spaces', 'idx_twin_home_spaces_parent', ['parent_space_id','kind','name'], false)
  assertIndexSignature(db, version, 'twin_home_objects', 'idx_twin_home_objects_space', ['space_id','kind','name'], false)
  assertIndexSignature(db, version, 'twin_home_inventory_ledger', 'idx_twin_home_inventory_ledger_source', ['source','source_id'], true)
  assertIndexSignature(db, version, 'twin_home_inventory_ledger', 'idx_twin_home_inventory_ledger_item', ['item_id','created_at'], false)
  assertIndexSignature(db, version, 'twin_home_devices', 'idx_twin_home_devices_space', ['space_id','device_class','name'], false)
  assertIndexSignature(db, version, 'twin_home_device_bindings', 'idx_twin_home_binding_provider_identity', ['provider','external_id'], true)
  assertIndexSignature(db, version, 'twin_home_device_bindings', 'idx_twin_home_bindings_device', ['device_id','provider'], false)
  assertIndexSignature(db, version, 'twin_home_provider_events', 'idx_twin_home_provider_event_identity', ['provider','event_id'], true)
  assertIndexSignature(db, version, 'twin_home_provider_events', 'idx_twin_home_provider_events_occurred',
    ['provider','occurred_at','provider_event_id'], false)
  assertIndexSignature(db, version, 'twin_home_device_states', 'idx_twin_home_device_states_observed', ['observed_at','device_id'], false)
  assertIndexSignature(db, version, 'twin_home_command_receipts', 'idx_twin_home_command_receipts_status',
    ['provider','status','updated_at'], false)

  const expectedForeignKeys: Record<string, Array<[string, string, string]>> = {
    twin_home_spaces: [['parent_space_id','twin_home_spaces','space_id']],
    twin_home_objects: [['space_id','twin_home_spaces','space_id']],
    twin_home_inventory_ledger: [['item_id','twin_home_inventory_items','item_id']],
    twin_home_devices: [['space_id','twin_home_spaces','space_id']],
    twin_home_device_bindings: [['device_id','twin_home_devices','device_id']],
    twin_home_device_states: [
      ['device_id','twin_home_devices','device_id'], ['source_event_id','twin_home_provider_events','provider_event_id'],
    ],
    twin_home_command_receipts: [['observed_event_id','twin_home_provider_events','provider_event_id']],
  }
  for (const [table, expectedKeys] of Object.entries(expectedForeignKeys)) {
    const actualKeys = (db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
      from: string; table: string; to: string; on_update: string; on_delete: string
    }>).map(key => [key.from, key.table, key.to, key.on_update, key.on_delete].join('|')).sort()
    const expectedKeysWithActions = expectedKeys.map(key => [...key, 'NO ACTION', 'NO ACTION'].join('|')).sort()
    if (actualKeys.length !== expectedKeysWithActions.length
      || actualKeys.some((key, index) => key !== expectedKeysWithActions[index])) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: ${table} foreign key signature is invalid`)
    }
  }

  const triggerFragments: Record<string, string[]> = {
    twin_home_inventory_ledger_no_update: ['before update on twin_home_inventory_ledger',
      "raise(abort,'home_inventory_ledger_immutable')"],
    twin_home_inventory_ledger_no_delete: ['before delete on twin_home_inventory_ledger',
      "raise(abort,'home_inventory_ledger_immutable')"],
    twin_home_provider_event_no_update: ['before update on twin_home_provider_events',
      "raise(abort,'home_provider_event_immutable')"],
    twin_home_provider_event_no_delete: ['before delete on twin_home_provider_events',
      "raise(abort,'home_provider_event_immutable')"],
    twin_home_command_receipt_identity_immutable: ['new.material_digest is not old.material_digest',
      "raise(abort,'home_command_receipt_identity_immutable')"],
    twin_home_command_receipt_no_delete: ['before delete on twin_home_command_receipts',
      "raise(abort,'home_command_receipt_immutable')"],
  }
  for (const [name, fragments] of Object.entries(triggerFragments)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    const sql = canonicalSql(row?.sql ?? '')
    if (fragments.some(fragment => !sql.includes(canonicalSql(fragment)))) {
      throw new Error(`Personal Twin schema version ${version} is incomplete: home runtime trigger signature is invalid`)
    }
  }
}

function probeReservationChecks(db: DatabaseSync): void {
  const consentId = `probe-consent-${'c'.repeat(32)}`
  const insert = db.prepare(`INSERT INTO twin_artifact_consent_reservations
    (reservation_id,consent_id,artifact_id,artifact_manifest_digest,processor,reserved_at,expires_at,consumed_at)
    VALUES(?,?,?,?,?,?,?,NULL)`)
  db.exec('SAVEPOINT twin_v7_reservation_probe')
  try {
    db.prepare(`INSERT INTO twin_artifact_consents
      (consent_id,manifest_digest,processor,scope_json,issued_at,expires_at,consumed_at,revoked_at)
      VALUES(?,?,?,'{}',?,?,NULL,NULL)`).run(
      consentId, 'c'.repeat(64), 'probe-processor', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')
    const valid = [`reservation-${'1'.repeat(36)}`, consentId, `artifact-${'a'.repeat(64)}`, 'b'.repeat(64),
      'probe-processor', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z'] as const
    const invalid = [
      ['bad-reservation', ...valid.slice(1)],
      [valid[0], valid[1], 'artifact-bad', ...valid.slice(3)],
      [...valid.slice(0, 3), 'not-a-digest', ...valid.slice(4)],
    ]
    for (const values of invalid) {
      let rejected = false
      try { insert.run(...values) } catch { rejected = true }
      if (!rejected) throw new Error('TWIN_V7_RESERVATION_CHECK_PROBE_FAILED')
    }
  } finally {
    db.exec('ROLLBACK TO twin_v7_reservation_probe; RELEASE twin_v7_reservation_probe')
  }
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
